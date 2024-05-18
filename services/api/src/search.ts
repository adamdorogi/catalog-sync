import {performance} from 'node:perf_hooks';
import {normalizeSku, type CatalogDocument} from '@catalog-sync/shared';
import {embed} from '@catalog-sync/shared/embeddings';
import {CATALOG_ALIAS, searchClient} from '@catalog-sync/shared/search-index';
import type {SearchParams} from './search-params.js';
import {effectivePrice, facetAggregations, lexicalClause, searchFilters, type Clause} from './search-query.js';

const rankWindow = 200;
const rrfK = 60;
const source = {excludes: ['embedding']};

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

const queryVectors = new Map<string, Promise<number[]>>();

function queryVector(query: string) {
  const key = query.toLowerCase();
  const pending = queryVectors.get(key);
  if (pending) return pending;
  if (queryVectors.size >= 128) {
    const oldest = queryVectors.keys().next().value;
    if (oldest !== undefined) queryVectors.delete(oldest);
  }
  const vector = embed(key).catch((error) => {
    queryVectors.delete(key);
    throw error;
  });
  queryVectors.set(key, vector);
  return vector;
}

function exactPartMatch(hit: RawHit, normalized: string) {
  if (!normalized) return false;
  const {skuNormalized, mpnNormalized, partNumbers} = hit.fields ?? {};
  return [skuNormalized?.[0], mpnNormalized?.[0], ...(partNumbers ?? [])].includes(normalized);
}

function score(): Score {
  return {lexicalRank: null, vectorRank: null, lexicalScore: null, vectorScore: null, rrfScore: null, exactPartMatch: false};
}

export function fuseRanks(lexical: RawHit[], vector: RawHit[], query: string) {
  const normalized = normalizeSku(query);
  const candidates = new Map<string, {hit: RawHit; score: Score}>();
  lexical.forEach((hit, index) => {
    const rank = index + 1;
    const explain = score();
    explain.lexicalRank = rank;
    explain.lexicalScore = hit._score;
    explain.exactPartMatch = exactPartMatch(hit, normalized);
    explain.rrfScore = 1 / (rrfK + rank);
    candidates.set(hit._id, {hit, score: explain});
  });
  vector.forEach((hit, index) => {
    const rank = index + 1;
    const candidate = candidates.get(hit._id) ?? {hit, score: score()};
    candidate.score.vectorRank = rank;
    candidate.score.vectorScore = hit._score;
    candidate.score.rrfScore = (candidate.score.rrfScore ?? 0) + 1 / (rrfK + rank);
    candidates.set(hit._id, candidate);
  });

  return [...candidates.values()].sort((left, right) => (
    Number(right.score.exactPartMatch) - Number(left.score.exactPartMatch)
      || (right.score.rrfScore ?? 0) - (left.score.rrfScore ?? 0)
      || (left.score.lexicalRank ?? Infinity) - (right.score.lexicalRank ?? Infinity)
      || left.hit._id.localeCompare(right.hit._id)
  ));
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

async function searchBatch(...bodies: Clause[]) {
  const response = await searchClient.msearch({
    index: CATALOG_ALIAS,
    body: bodies.flatMap((body) => [{}, body]),
  });
  return (response.body.responses as RawSearch[]).map(validateResponse);
}

export async function searchCatalog(params: SearchParams) {
  const started = performance.now();
  const from = (params.page - 1) * params.pageSize;
  const {base, filters} = searchFilters(params);
  const selected = filters.map((filter) => filter.clause);
  const lexical = lexicalClause(params.q);
  const exactFields = ['skuNormalized', 'mpnNormalized', 'partNumbers'];
  const aggregations = params.facets ? facetAggregations(params, filters) : undefined;

  const textQuery = {bool: {must: [lexical], filter: base}};
  const postFilter = selected.length ? {bool: {filter: selected}} : undefined;
  const sort = params.q ? [{_score: 'desc'}, {'sku.keyword': 'asc'}] : [{'sku.keyword': 'asc'}];
  let result: RawSearch;
  let hits: ReturnType<typeof presentHit>[];
  let total: number;
  let facetResult: RawFacets | undefined;

  if (!params.q || params.mode === 'lexical') {
    result = await searchOne({
      query: textQuery, post_filter: postFilter, aggs: aggregations, sort,
      from, size: params.pageSize, track_total_hits: true, _source: source,
      docvalue_fields: params.q ? exactFields : undefined,
    });
    const normalized = normalizeSku(params.q);
    total = result.hits.total?.value ?? 0;
    hits = result.hits.hits.map((hit, index) => presentHit(hit, {
      ...score(),
      lexicalRank: params.q ? from + index + 1 : null,
      lexicalScore: hit._score,
      exactPartMatch: exactPartMatch(hit, normalized),
    }, params));
    facetResult = result.aggregations;
  } else {
    const vector = await queryVector(params.q);
    const knn = {knn: {embedding: {vector, k: rankWindow, filter: {bool: {filter: [...base, ...selected]}}}}};
    const vectorRequest = {query: knn, sort, track_total_hits: true};
    const facetsRequest = {size: 0, query: {bool: {filter: base}}, aggs: aggregations, track_total_hits: false};
    const facetRequests = aggregations ? [facetsRequest] : [];

    if (params.mode === 'semantic') {
      const body = {...vectorRequest, from, size: Math.min(params.pageSize, Math.max(0, rankWindow - from)), _source: source};
      const [vectors, facets] = await searchBatch(body, ...facetRequests);
      result = vectors;
      total = Math.min(rankWindow, vectors.hits.total?.value ?? vectors.hits.hits.length);
      hits = vectors.hits.hits.map((hit, index) => presentHit(hit, {
        ...score(), vectorRank: from + index + 1, vectorScore: hit._score,
      }, params));
      facetResult = facets?.aggregations;
    } else {
      const [words, vectors, facets] = await searchBatch({
        query: textQuery, post_filter: postFilter, size: rankWindow, sort,
        _source: false, docvalue_fields: exactFields, track_total_hits: false,
      }, {...vectorRequest, size: rankWindow, _source: false}, ...facetRequests);
      result = words.hits.hits.length ? words : vectors;
      const ranked = fuseRanks(words.hits.hits, vectors.hits.hits, params.q);
      const page = ranked.slice(from, from + params.pageSize);
      total = ranked.length;
      facetResult = facets?.aggregations;
      hits = [];
      if (page.length) {
        const response = await searchClient.mget({body: {docs: page.map(({hit}) => ({
          _index: hit._index, _id: hit._id, _source: source,
        }))}});
        const docs = response.body.docs as ({found?: boolean; _source?: IndexedDocument})[];
        hits = page.flatMap(({hit, score: explain}, index) => {
          const doc = docs[index];
          return doc?.found && doc._source?.active ? [presentHit({...hit, _source: doc._source}, explain, params)] : [];
        });
      }
    }
  }

  return {
    hits, total, page: params.page, pageSize: params.pageSize,
    tookMs: Math.round((performance.now() - started) * 10) / 10,
    index: result.hits.hits[0]?._index ?? CATALOG_ALIAS,
    facets: formatFacets(facetResult),
  };
}

export async function getSearchDocument(id: string) {
  const response = await searchClient.get({index: CATALOG_ALIAS, id}, {ignore: [404]});
  const body = response.body as {found?: boolean; _source?: IndexedDocument};
  return body.found && body._source?.active ? body._source : null;
}
