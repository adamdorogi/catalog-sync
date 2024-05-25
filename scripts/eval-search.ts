import {seedExamples} from '@catalog-sync/shared';

const baseUrl = process.env.CATALOG_API_URL ?? 'http://127.0.0.1:4000';
const modes = ['lexical', 'semantic', 'hybrid'] as const;
const cases = seedExamples.map((example, index) => ({
  sku: example.sku,
  query: index % 2 === 0 ? example.query : index % 4 === 1 ? example.sku : example.mpn,
  kind: index % 2 === 0 ? 'description' : 'part number',
}));

type Result = {scope: string; mode: typeof modes[number]; rank: number; tookMs: number};

async function search(query: string, mode: typeof modes[number]) {
  const url = new URL('/api/search', baseUrl);
  url.search = new URLSearchParams({q: query, mode, pageSize: '10', facets: 'false'}).toString();
  const response = await fetch(url, {signal: AbortSignal.timeout(120_000)});
  if (!response.ok) throw new Error(`Search ${response.status} for ${mode} ${query}: ${await response.text()}`);
  return await response.json() as {hits: {product: {sku: string}}[]; tookMs: number};
}

function summarize(results: Result[], scope: string, mode: Result['mode']) {
  const rows = results.filter((row) => row.mode === mode && (scope === 'all' || row.scope === scope));
  const reciprocal = rows.reduce((sum, {rank}) => sum + (rank ? 1 / rank : 0), 0);
  const found = rows.filter(({rank}) => rank > 0).length;
  const times = rows.map(({tookMs}) => tookMs).sort((a, b) => a - b);
  return {
    scope,
    mode,
    queries: rows.length,
    'MRR@10': (reciprocal / rows.length).toFixed(3),
    'Recall@10': (found / rows.length).toFixed(3),
    'p95 ms': times[Math.ceil(0.95 * times.length) - 1].toFixed(1),
  };
}

async function main() {
  const first = cases[0];
  const indexed = await search(first.sku, 'lexical');
  if (indexed.hits[0]?.product.sku !== first.sku) throw new Error('Seed and index the catalog before running eval:search');
  await search('catalog search warmup', 'hybrid');

  const results: Result[] = [];
  for (const [index, test] of cases.entries()) {
    // rotate the first arm so vector cache warmup is shared across modes
    for (let offset = 0; offset < modes.length; offset += 1) {
      const mode = modes[(index + offset) % modes.length];
      const response = await search(test.query, mode);
      const rank = response.hits.findIndex(({product}) => product.sku === test.sku) + 1;
      results.push({scope: test.kind, mode, rank, tookMs: response.tookMs});
    }
  }
  console.table(['all', 'part number', 'description'].flatMap((scope) => modes.map((mode) => summarize(results, scope, mode))));
  if (process.argv.includes('--queries')) {
    console.table(cases.map((test, index) => ({
      query: test.query, expectedSku: test.sku,
      ...Object.fromEntries(results.slice(index * modes.length, (index + 1) * modes.length)
        .map(({mode, rank}) => [mode, rank || '-'])),
    })));
  }
}

await main();
