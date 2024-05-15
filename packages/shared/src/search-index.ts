import { Client } from '@opensearch-project/opensearch';
import { config } from './config.js';
import { embeddingModel, embedMany } from './embeddings.js';
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
const prefix = {
  ...keyword,
  fields: {
    prefix: {
      type: 'text',
      analyzer: 'part_prefix',
      search_analyzer: 'part_exact',
    },
  },
};
const integer = { type: 'integer' };

export const catalogIndexDefinition = {
  settings: {
    index: {
      number_of_shards: Number(process.env.OPENSEARCH_PRIMARY_SHARDS ?? 1),
      number_of_replicas: Number(process.env.OPENSEARCH_REPLICAS ?? 0),
      refresh_interval: '500ms',
      max_ngram_diff: 31,
      knn: true,
    },
    analysis: {
      char_filter: {
        part_punctuation: { type: 'pattern_replace', pattern: '[^\\p{L}\\p{N}]', replacement: '' },
      },
      filter: {
        part_edge: { type: 'edge_ngram', min_gram: 1, max_gram: 32 },
      },
      analyzer: {
        part_exact: {
          tokenizer: 'keyword',
          char_filter: ['part_punctuation'],
          filter: ['lowercase'],
        },
        part_prefix: {
          tokenizer: 'keyword',
          char_filter: ['part_punctuation'],
          filter: ['lowercase', 'part_edge'],
        },
      },
    },
  },
  mappings: {
    dynamic: false,
    properties: {
      id: keyword,
      revision: { type: 'long' },
      sku: { type: 'text', fields: { keyword } },
      mpn: { type: 'text' },
      skuNormalized: prefix,
      mpnNormalized: prefix,
      partNumbers: prefix,
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
      embedding: {
        type: 'knn_vector',
        dimension: 384,
        method: {
          name: 'hnsw',
          engine: 'lucene',
          space_type: 'l2',
          parameters: { ef_construction: 100, m: 16 },
        },
      },
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

function semanticText(document: CatalogDocument): string {
  const attributes = Object.entries(document.attributes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name} ${value}`);
  return [document.title, document.category, ...attributes, document.description, document.brand]
    .filter(Boolean)
    .join(' ')
    .slice(0, 1500);
}

export async function readSearchEmbeddings(documents: CatalogDocument[]): Promise<Map<string, number[]>> {
  const revisions = new Map(documents.filter((doc) => doc.active).map((doc) => [doc.id, doc.revision]));
  if (!revisions.size) {
    return new Map();
  }
  const { body } = await searchClient.mget({
    index: CATALOG_ALIAS,
    _source: ['embedding', 'embeddingModel', 'revision'],
    body: { ids: [...revisions.keys()] },
  });
  const matching = new Map<string, number[]>();
  for (const hit of body.docs as {
    _id: string;
    _source?: { embedding?: number[]; embeddingModel?: string; revision: string };
  }[]) {
    const source = hit._source;
    if (source?.embedding?.length === 384 && source.embeddingModel === embeddingModel &&
      source.revision === revisions.get(hit._id)) {
      matching.set(hit._id, source.embedding);
    }
  }
  return matching;
}

export async function prepareIndexWrites(
  events: CatalogEvent[],
  existing = new Map<string, number[]>(),
  signal?: AbortSignal
): Promise<IndexWrite[]> {
  const upserts = events.flatMap((event) =>
    event.type === 'UPSERT' && event.document.active && !existing.has(event.productId) ? [event.document] : []);
  const vectors = await embedMany(upserts.map(semanticText), signal);
  let vector = 0;
  return events.map((event) => {
    const active = event.type === 'UPSERT' && event.document?.active;
    return {
      id: event.productId,
      version: event.eventId,
      document: active && event.document
        ? { ...searchDocument(event.document), embeddingModel, embedding: existing.get(event.productId) ?? vectors[vector++] }
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
