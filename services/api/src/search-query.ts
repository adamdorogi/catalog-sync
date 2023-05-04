import {normalizeSku, type CatalogDocument} from '@catalog-sync/shared';
import type {SearchParams} from './search-params.js';

export type Clause = Record<string, unknown>;

type Filter = {
  facet: 'category' | 'brand' | 'warehouse' | 'inStock' | 'price' | 'attribute';
  clause: Clause;
};

export function effectivePrice(product: CatalogDocument, tier: SearchParams['tier'], quantity: number) {
  let minimum = 0;
  let price = product.basePriceCents;
  for (const row of product.tierPrices) {
    if (row.tierCode === tier && row.minQty <= quantity && row.minQty > minimum) {
      minimum = row.minQty;
      price = row.unitPriceCents;
    }
  }
  return price;
}

const priceSource = `
  int price = (int)doc['basePriceCents'].value;
  int minimum = 0;
  for (String offer : doc['tierOffers']) {
    if (!offer.startsWith(params.prefix)) continue;
    int next = offer.indexOf(':', params.prefix.length());
    int qty = Integer.parseInt(offer.substring(params.prefix.length(), next));
    if (qty <= params.quantity && qty > minimum) {
      minimum = qty;
      price = Integer.parseInt(offer.substring(next + 1));
    }
  }
`;

function priceScript(params: SearchParams, tail: string) {
  return {
    lang: 'painless',
    source: `${priceSource}${tail}`,
    params: {prefix: `${params.tier}:`, quantity: params.quantity},
  };
}

function priceFilter(params: SearchParams): Clause | undefined {
  if (params.minPriceCents === undefined && params.maxPriceCents === undefined) return;
  if (params.quantity === 1) {
    return {range: {[`effectivePrices.${params.tier}`]: {gte: params.minPriceCents, lte: params.maxPriceCents}}};
  }
  const script = priceScript(params, 'return price >= params.min && price <= params.max;');
  return {script: {script: {
    ...script,
    params: {...script.params, min: params.minPriceCents ?? 0, max: params.maxPriceCents ?? 2_147_483_647},
  }}};
}

const inStock: Clause = {range: {availableStock: {gt: 0}}};
const availableWarehouse: Clause = {range: {'inventory.available': {gt: 0}}};

function nested(path: string, filter: Clause[]): Clause {
  return {nested: {path, score_mode: 'none', query: {bool: {filter}}}};
}

export function searchFilters(params: SearchParams) {
  const base: Clause[] = [{term: {active: true}}];
  if (params.sku) base.push({term: {'sku.keyword': params.sku.toUpperCase()}});

  const filters: Filter[] = [];
  if (params.category.length) filters.push({facet: 'category', clause: {terms: {category: params.category}}});
  if (params.brand.length) filters.push({facet: 'brand', clause: {terms: {brand: params.brand}}});
  if (params.warehouse.length) {
    filters.push({facet: 'warehouse', clause: nested('inventory', [{terms: {'inventory.warehouseCode': params.warehouse}}])});
  }
  if (params.inStock) {
    const clause = params.warehouse.length
      ? nested('inventory', [{terms: {'inventory.warehouseCode': params.warehouse}}, availableWarehouse])
      : inStock;
    filters.push({facet: 'inStock', clause});
  }
  const price = priceFilter(params);
  if (price) filters.push({facet: 'price', clause: price});

  const attributes = new Map<string, string[]>();
  for (const entry of params.attribute) {
    const colon = entry.indexOf(':');
    const key = entry.slice(0, colon).trim();
    const values = attributes.get(key) ?? [];
    values.push(entry.slice(colon + 1).trim());
    attributes.set(key, values);
  }
  for (const [key, values] of attributes) {
    filters.push({facet: 'attribute', clause: nested('attributePairs', [
      {term: {'attributePairs.key': key}},
      {terms: {'attributePairs.value': values}},
    ])});
  }
  return {base, filters};
}

export function lexicalClause(q: string): Clause {
  if (!q) return {match_all: {}};
  const normalized = normalizeSku(q);
  const should: Clause[] = [{multi_match: {
    query: q,
    type: 'best_fields',
    fields: ['title^6', 'mpn^4', 'sku^3', 'description^2', 'brand^1.7', 'category'],
    minimum_should_match: '2<70%',
  }}];
  if (normalized) {
    should.push(
      {term: {skuNormalized: {value: normalized, boost: 300}}},
      {term: {mpnNormalized: {value: normalized, boost: 160}}},
      {term: {partNumbers: {value: normalized, boost: 90}}},
    );
  }
  return {bool: {should, minimum_should_match: 1}};
}

export function facetAggregations(params: SearchParams, filters: Filter[]) {
  function except(...facets: Filter['facet'][]) {
    return filters.filter((entry) => !facets.includes(entry.facet)).map((entry) => entry.clause);
  }

  const warehouses: Clause = {terms: {field: 'inventory.warehouseCode', size: 50}};
  const warehouseValues = params.inStock
    ? {available: {filter: availableWarehouse, aggs: {values: warehouses}}}
    : {values: warehouses};
  const priceMetric = params.quantity === 1
    ? {field: `effectivePrices.${params.tier}`}
    : {script: priceScript(params, 'return price;')};
  const stockFilter = params.warehouse.length
    ? nested('inventory', [{terms: {'inventory.warehouseCode': params.warehouse}}, availableWarehouse])
    : inStock;

  return {
    categories: {filter: {bool: {filter: except('category')}}, aggs: {values: {terms: {field: 'category', size: 50}}}},
    brands: {filter: {bool: {filter: except('brand')}}, aggs: {values: {terms: {field: 'brand', size: 50}}}},
    warehouses: {
      filter: {bool: {filter: except('warehouse', 'inStock')}},
      aggs: {inventory: {nested: {path: 'inventory'}, aggs: warehouseValues}},
    },
    attributes: {
      filter: {bool: {filter: except('attribute')}},
      aggs: {pairs: {
        nested: {path: 'attributePairs'},
        aggs: {keys: {terms: {field: 'attributePairs.key', size: 24}, aggs: {
          values: {terms: {field: 'attributePairs.value', size: 24}},
        }}},
      }},
    },
    inStock: {filter: {bool: {filter: [...except('inStock'), stockFilter]}}},
    price: {filter: {bool: {filter: except('price')}}, aggs: {
      min: {min: priceMetric},
      max: {max: priceMetric},
    }},
  };
}
