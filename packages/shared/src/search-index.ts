import { Client } from '@opensearch-project/opensearch';
import { config } from './config.js';
import type { CatalogDocument, CatalogEvent } from './events.js';
import { normalizeSku } from './events.js';

export const CATALOG_ALIAS = 'catalog_current';

export const searchClient = new Client({
  node: config.openSearchNode,
  auth: config.openSearchUsername && config.openSearchPassword
    ? { username: config.openSearchUsername, password: config.openSearchPassword }
    : undefined,
  ssl: { rejectUnauthorized: config.openSearchTlsRejectUnauthorized },
  requestTimeout: 30_000,
  maxRetries: 0,
});

const keyword = { type: 'keyword' };
const integer = { type: 'integer' };

export const catalogIndexDefinition = {
  settings: {
    index: {
      number_of_shards: Number(process.env.OPENSEARCH_PRIMARY_SHARDS ?? 1),
      number_of_replicas: Number(process.env.OPENSEARCH_REPLICAS ?? 0),
      refresh_interval: '500ms',
    },
  },
  mappings: {
    dynamic: false,
    properties: {
      id: keyword,
      revision: { type: 'long' },
      sku: { type: 'text', fields: { keyword } },
      mpn: { type: 'text' },
      skuNormalized: keyword,
      mpnNormalized: keyword,
      partNumbers: keyword,
      title: { type: 'text' },
      description: { type: 'text' },
      brand: keyword,
      category: keyword,
      active: { type: 'boolean' },
      updatedAt: { type: 'date' },
      attributes: { type: 'object', enabled: false },
      attributePairs: {
        type: 'nested',
        properties: { key: keyword, value: keyword },
      },
      inventory: {
        type: 'nested',
        properties: { warehouseCode: keyword, onHand: integer, reserved: integer, available: integer },
      },
      tierPrices: {
        type: 'nested',
        properties: { tierCode: keyword, minQty: integer, unitPriceCents: integer },
      },
      tierOffers: keyword,
      effectivePrices: {
        properties: { RETAIL: integer, TRADE: integer, WHOLESALE: integer },
      },
      basePriceCents: integer,
      availableStock: { type: 'long' },
    },
  },
};

export interface IndexWrite {
  id: string;
  version: string;
  document: Record<string, unknown>;
}

function searchDocument(document: CatalogDocument): Record<string, unknown> {
  const { sku, mpn, attributes, inventory, tierPrices } = document;
  const skuSegments = sku.split(/[-\s]+/);
  const partNumbers = new Set([
    normalizeSku(sku),
    normalizeSku(mpn),
    ...skuSegments.slice(1).map((_, offset) => normalizeSku(skuSegments.slice(offset + 1).join(''))),
  ]);
  const warehouses = inventory.map((stock) => ({
    ...stock,
    available: Math.max(0, stock.onHand - stock.reserved),
  }));
  const effectivePrices: Record<string, number> = {
    RETAIL: document.basePriceCents,
    TRADE: document.basePriceCents,
    WHOLESALE: document.basePriceCents,
  };
  for (const tier of tierPrices) {
    if (tier.minQty === 1) {
      effectivePrices[tier.tierCode] = tier.unitPriceCents;
    }
  }
  return {
    ...document,
    skuNormalized: normalizeSku(sku),
    mpnNormalized: normalizeSku(mpn),
    partNumbers: [...partNumbers].filter(Boolean),
    attributePairs: Object.entries(attributes).map(([key, value]) => ({ key, value })),
    inventory: warehouses,
    availableStock: warehouses.reduce((sum, stock) => sum + stock.available, 0),
    effectivePrices,
    tierOffers: tierPrices.map((tier) => `${tier.tierCode}:${tier.minQty}:${tier.unitPriceCents}`),
  };
}

export async function prepareIndexWrites(
  events: CatalogEvent[],
  _existing?: Map<string, number[]>,
  signal?: AbortSignal
): Promise<IndexWrite[]> {
  signal?.throwIfAborted();
  return events.map((event) => {
    const active = event.type === 'UPSERT' && event.document?.active;
    return {
      id: event.productId,
      version: event.eventId,
      document: active && event.document
        ? searchDocument(event.document)
        // Keep the deletion version past the OpenSearch delete tombstone TTL.
        : { id: event.productId, revision: event.eventId, active: false },
    };
  });
}

export function toBulkBody(index: string, writes: IndexWrite[]): Record<string, unknown>[] {
  return writes.flatMap((write) => [
    {
      index: {
        _index: index,
        _id: write.id,
        version_type: 'external',
        version: write.version,
      },
    },
    write.document,
  ]);
}

interface BulkItem {
  status: number;
  error?: { type?: string; reason?: string };
}

export interface BulkFailure {
  id: string;
  status: number;
  reason: string;
}

const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function bulkIndex(
  index: string,
  writes: IndexWrite[],
  wait: (milliseconds: number) => Promise<void> = pause
): Promise<{ indexed: number; failures: BulkFailure[]; durationMs: number }> {
  const start = performance.now();
  const failures: BulkFailure[] = [];
  let indexed = 0;
  let pending = writes;
  for (let attempt = 0; pending.length > 0; attempt += 1) {
    let response;
    try {
      response = await searchClient.bulk({ body: toBulkBody(index, pending) });
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (attempt < 4 && (!status || retryableStatuses.has(status))) {
        await wait(100 * 2 ** attempt);
        continue;
      }
      throw error;
    }
    const body = response.body as { errors: boolean; items: { index: BulkItem }[] };
    if (body.items.length !== pending.length) {
      throw new Error('bulk response item count differs from request');
    }
    if (!body.errors) {
      indexed += pending.length;
      break;
    }
    const retry: IndexWrite[] = [];
    body.items.forEach(({ index: item }, position) => {
      const write = pending[position];
      if (item.status < 300) {
        indexed += 1;
      } else if (item.status === 409 && item.error?.type === 'version_conflict_engine_exception') {
        return;
      } else if (retryableStatuses.has(item.status)) {
        retry.push(write);
      } else {
        failures.push({
          id: write.id,
          status: item.status,
          reason: `${item.error?.type ?? 'bulk item error'}: ${item.error?.reason ?? item.status}`,
        });
      }
    });
    if (retry.length && attempt >= 4) {
      throw new Error(`transient bulk errors after retries (${retry.length} docs)`);
    }
    if (retry.length) {
      await wait(100 * 2 ** attempt);
    }
    pending = retry;
  }
  return { indexed, failures, durationMs: performance.now() - start };
}

export async function getAliasIndices(): Promise<string[]> {
  try {
    const { body } = await searchClient.indices.getAlias({ name: CATALOG_ALIAS });
    return Object.keys(body);
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) {
      return [];
    }
    throw error;
  }
}
