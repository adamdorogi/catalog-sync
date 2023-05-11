import {describe, expect, it} from 'vitest';
import type {CatalogDocument} from '@catalog-sync/shared';
import {searchParams} from './search-params.js';
import {effectivePrice, searchFilters} from './search-query.js';

describe('search filters', () => {
  it('combines selected warehouse and available stock within one inventory row', () => {
    const params = searchParams.parse({warehouse: ['BNE-01', 'SYD-02'], inStock: 'true'});
    const stock = searchFilters(params).filters.find((filter) => filter.facet === 'inStock');
    expect(stock?.clause).toEqual({nested: {
      path: 'inventory', score_mode: 'none', query: {bool: {filter: [
        {terms: {'inventory.warehouseCode': ['BNE-01', 'SYD-02']}},
        {range: {'inventory.available': {gt: 0}}},
      ]}},
    }});
  });

  it('uses OR within an attribute key and rejects an inverted price range', () => {
    const params = searchParams.parse({attribute: ['thread:M10', 'thread:M12', 'material:316 Stainless']});
    const {filters} = searchFilters(params);
    expect(filters).toHaveLength(2);
    expect(filters[0].clause).toMatchObject({nested: {query: {bool: {filter: [
      {term: {'attributePairs.key': 'thread'}}, {terms: {'attributePairs.value': ['M10', 'M12']}},
    ]}}}});
    expect(() => searchParams.parse({minPriceCents: '950', maxPriceCents: '900'})).toThrow();
  });

  it('uses the highest eligible quantity break within the selected tier', () => {
    const product: CatalogDocument = {
      id: 'c99494b8-38bf-4ff5-9a1f-d535d233e8f0', revision: '1', sku: 'FAST-M12', mpn: 'M12',
      title: 'Hex nut', description: '', brand: 'Fixture', category: 'Fasteners', attributes: {},
      basePriceCents: 150, active: true, updatedAt: '2026-11-23T11:43:21+01:00', inventory: [],
      tierPrices: [
        {tierCode: 'TRADE', minQty: 10, unitPriceCents: 100},
        {tierCode: 'WHOLESALE', minQty: 4, unitPriceCents: 80},
        {tierCode: 'TRADE', minQty: 4, unitPriceCents: 120},
      ],
    };
    expect(effectivePrice(product, 'TRADE', 1)).toBe(150);
    expect(effectivePrice(product, 'TRADE', 7)).toBe(120);
    expect(effectivePrice(product, 'TRADE', 10)).toBe(100);
  });
});
