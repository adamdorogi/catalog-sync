import { setTimeout as delay } from 'node:timers/promises';
import { config, type CatalogDocument } from '@catalog-sync/shared';
import { describe, expect, it } from 'vitest';

interface SearchResult {
  index: string;
  hits: {
    product: CatalogDocument;
    unitPriceCents: number;
    score: { exactPartMatch: boolean; lexicalRank: number | null; vectorRank: number | null };
  }[];
  facets: { categories: { value: string; count: number }[] };
}

interface ReindexResult {
  job: { id: string; status: string; targetIndex: string | null; error: string | null };
}

const integration = process.env.CATALOG_PIPELINE_INTEGRATION === '1' ? describe : describe.skip;
const apiRoot = process.env.CATALOG_TEST_API_URL || `http://127.0.0.1:${config.port}`;
const sku = 'FAST-HXN-SS316-M12';
const lexical = '/api/search?q=HXNSS316M12&category=Fasteners&mode=lexical';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (config.apiAdminToken) headers.set('Authorization', `Bearer ${config.apiAdminToken}`);
  const response = await fetch(new URL(path, apiRoot), { ...options, headers, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function seededSearch(): Promise<SearchResult> {
  const deadline = Date.now() + 180000;
  let error: unknown;
  do {
    try {
      const result = await request<SearchResult>(lexical);
      if (result.hits[0]?.product.sku === sku) return result;
    } catch (cause) {
      error = cause;
    }
    await delay(300);
  } while (Date.now() < deadline);
  throw new Error(`seeded SKU ${sku} did not reach OpenSearch`, { cause: error });
}

integration('catalog pipeline through HTTP', () => {
  it('propagates an atomic stock and price edit and keeps serving while the alias swaps', async () => {
    const initial = await seededSearch();
    expect(initial.facets.categories).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'Fasteners', count: expect.any(Number) }),
    ]));

    const sample = initial.hits[0].product;
    const basePriceCents = sample.basePriceCents + 37;
    const onHand = (sample.inventory.find(({ warehouseCode }) => warehouseCode === 'BNE-01')?.onHand ?? 0) + 11;
    const edited = await request<{ product: CatalogDocument }>(`/api/products/${sku}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ basePriceCents, inventory: { warehouseCode: 'BNE-01', onHand } }),
    });
    expect(BigInt(edited.product.revision)).toBeGreaterThan(BigInt(sample.revision));
    await expect.poll(async () => {
      const result = await request<SearchResult>(lexical);
      return result.hits[0]?.product.revision;
    }, { timeout: 30000, interval: 200 }).toBe(edited.product.revision);

    const hybrid = await request<SearchResult>(`${lexical.replace('mode=lexical', 'mode=hybrid')}&sku=${sku}`);
    expect(hybrid.hits[0]).toMatchObject({
      product: {
        sku,
        inventory: expect.arrayContaining([
          expect.objectContaining({ warehouseCode: 'BNE-01', onHand, reserved: expect.any(Number) }),
        ]),
      },
      unitPriceCents: basePriceCents,
      score: { exactPartMatch: true, lexicalRank: 1, vectorRank: expect.any(Number) },
    });

    const { job } = await request<ReindexResult>('/api/admin/reindex', { method: 'POST' });
    const deadline = Date.now() + 120000;
    let rebuilt: SearchResult | undefined;
    do {
      const search = await request<SearchResult>(lexical);
      expect(search.hits[0]?.product).toMatchObject({ sku, revision: edited.product.revision });
      const { job: progress } = await request<ReindexResult>('/api/admin/reindex');
      expect(progress.id).toBe(job.id);
      if (progress.status === 'FAILED') throw new Error(progress.error ?? 'Reindex failed');
      if (progress.status === 'SUCCEEDED') {
        rebuilt = await request<SearchResult>(lexical);
        expect(rebuilt.index).toBe(progress.targetIndex);
        break;
      }
      await delay(250);
    } while (Date.now() < deadline);

    expect(rebuilt).toBeDefined();
    expect(rebuilt?.index).not.toBe(initial.index);
    expect(rebuilt?.hits[0]?.product).toMatchObject({ sku, revision: edited.product.revision });
  }, 360000);
});
