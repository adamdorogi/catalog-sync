import {performance} from 'node:perf_hooks';
import {normalizeSku, type CatalogDocument} from '@catalog-sync/shared';
import {CATALOG_ALIAS, searchClient} from '@catalog-sync/shared/search-index';
import type {SearchParams} from './search-params.js';
import {effectivePrice, facetAggregations, lexicalClause, searchFilters, type Clause} from './search-query.js';


type IndexedDocument = CatalogDocument & Record<string, unknown>;
type Bucket = {key: string; doc_count: number};
type Buckets = {buckets: Bucket[]};
type RawFacets = {
  categories: {values: Buckets};
  brands: {values: Buckets};
  warehouses: {inventory: {values?: Buckets; available?: {values: Buckets}}};
  attributes: {pairs: {keys: {buckets: (Bucket & {values: Buckets})[]}}};
  inStock: {doc_count: number};
  price: {min: {value: number | null}; max: {value: number | null}};
};

type RawHit = {
  _id: string;
  _index: string;
  _score: number | null;
  _source?: IndexedDocument;
  fields?: {skuNormalized?: string[]; mpnNormalized?: string[]; partNumbers?: string[]};
};

type RawSearch = {
  error?: {type?: string; reason?: string};
  timed_out?: boolean;
  _shards?: {failed: number};
  hits: {total?: {value: number}; hits: RawHit[]};
  aggregations?: RawFacets;
};

type Score = {
  lexicalRank: number | null;
  vectorRank: number | null;
  lexicalScore: number | null;
  vectorScore: number | null;
  rrfScore: number | null;
  exactPartMatch: boolean;
};

function exactPartMatch(hit: RawHit, normalized: string) {
  if (!normalized) return false;
  const {skuNormalized, mpnNormalized, partNumbers} = hit.fields ?? {};
  return [skuNormalized?.[0], mpnNormalized?.[0], ...(partNumbers ?? [])].includes(normalized);
}

function score(): Score {
  return {lexicalRank: null, vectorRank: null, lexicalScore: null, vectorScore: null, rrfScore: null, exactPartMatch: false};
}

function facetValues(buckets?: Buckets) {
  return (buckets?.buckets ?? []).map(({key, doc_count}) => ({value: key, count: doc_count}));
}

function formatFacets(facets?: RawFacets) {
  const inventory = facets?.warehouses.inventory;
  return {
    categories: facetValues(facets?.categories.values),
    brands: facetValues(facets?.brands.values),
    warehouses: facetValues(inventory?.values ?? inventory?.available?.values),
    attributes: Object.fromEntries((facets?.attributes.pairs.keys.buckets ?? [])
      .map((key) => [key.key, facetValues(key.values)])),
    inStockCount: facets?.inStock.doc_count ?? 0,
    price: {min: facets?.price.min.value ?? null, max: facets?.price.max.value ?? null},
  };
}

function presentHit(hit: RawHit, explain: Score, params: SearchParams) {
  const doc = hit._source;
  if (!doc) throw new Error(`Missing indexed source for ${hit._id}`);
  const product: CatalogDocument = {
    id: doc.id,
    revision: doc.revision,
    sku: doc.sku,
    mpn: doc.mpn,
    title: doc.title,
    description: doc.description,
    category: doc.category,
    brand: doc.brand,
    attributes: doc.attributes,
    basePriceCents: doc.basePriceCents,
    active: doc.active,
    updatedAt: doc.updatedAt,
    inventory: doc.inventory,
    tierPrices: doc.tierPrices,
  };
  return {product, unitPriceCents: effectivePrice(product, params.tier, params.quantity), score: explain, indexedDocument: doc};
}

function validateResponse(body: RawSearch) {
  if (body.error) throw new Error(`OpenSearch: ${body.error.reason ?? body.error.type ?? 'query failed'}`);
  if (body.timed_out || body._shards?.failed) throw new Error('OpenSearch returned partial results');
  return body;
}

async function searchOne(body: Clause) {
  const response = await searchClient.search({index: CATALOG_ALIAS, body});
  return validateResponse(response.body as RawSearch);
}

export async function searchCatalog(params: SearchParams) {
  const started = performance.now();
  const from = (params.page - 1) * params.pageSize;
  const {base, filters} = searchFilters(params);
  const selected = filters.map((filter) => filter.clause);
  const query = {bool: {must: [lexicalClause(params.q)], filter: base}};
  const postFilter = selected.length ? {bool: {filter: selected}} : undefined;
  const sort = params.q ? [{_score: 'desc'}, {'sku.keyword': 'asc'}] : [{'sku.keyword': 'asc'}];
  const result = await searchOne({
    query, post_filter: postFilter, sort,
    aggs: params.facets ? facetAggregations(params, filters) : undefined,
    from, size: params.pageSize, track_total_hits: true,
    docvalue_fields: params.q ? ['skuNormalized', 'mpnNormalized', 'partNumbers'] : undefined,
  });
  const normalized = normalizeSku(params.q);
  const hits = result.hits.hits.map((hit, index) => presentHit(hit, {
    ...score(),
    lexicalRank: params.q ? from + index + 1 : null,
    lexicalScore: hit._score,
    exactPartMatch: exactPartMatch(hit, normalized),
  }, params));
  return {
    hits, total: result.hits.total?.value ?? 0, page: params.page, pageSize: params.pageSize,
    tookMs: Math.round((performance.now() - started) * 10) / 10,
    index: result.hits.hits[0]?._index ?? CATALOG_ALIAS,
    facets: formatFacets(result.aggregations),
  };
}

export async function getSearchDocument(id: string) {
  const response = await searchClient.get({index: CATALOG_ALIAS, id}, {ignore: [404]});
  const body = response.body as {found?: boolean; _source?: IndexedDocument};
  return body.found && body._source?.active ? body._source : null;
}
