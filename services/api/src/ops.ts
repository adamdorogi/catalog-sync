import {pool} from '@catalog-sync/shared';
import {readConsumerLag} from '@catalog-sync/shared/kafka';
import {readBulkStats} from '@catalog-sync/shared/pipeline-ops';
import {getReindexProgress} from '@catalog-sync/shared/reindex';
import {getAliasIndices, searchClient} from '@catalog-sync/shared/search-index';

async function outboxPending() {
  const result = await pool.query<{pending: string}>(
    'SELECT count(*) AS pending FROM outbox_events WHERE published_at IS NULL',
  );
  return Number(result.rows[0].pending);
}

async function searchStats() {
  const indices = await getAliasIndices();
  if (!indices.length) return {documents: 0, primaryShards: 0, indices};
  const index = indices.join(',');
  const [documents, settings] = await Promise.all([
    searchClient.count({index, body: {query: {term: {active: true}}}}),
    searchClient.indices.getSettings({index, flat_settings: true}),
  ]);
  const primaryShards = indices.reduce((total, name) => (
    total + Number(settings.body[name]?.settings?.['index.number_of_shards'] ?? 0)
  ), 0);
  return {documents: Number(documents.body.count), primaryShards, indices};
}

export async function readOps() {
  const [outbox, kafka, search, bulk, reindex] = await Promise.allSettled([
    outboxPending(), readConsumerLag(), searchStats(), readBulkStats(), getReindexProgress(),
  ]);
  const errors: Record<string, string> = {};
  function value<T>(key: string, result: PromiseSettledResult<T>) {
    if (result.status === 'fulfilled') return result.value;
    errors[key] = result.reason instanceof Error ? result.reason.message : String(result.reason);
    return null;
  }
  return {
    outboxPending: value('outbox', outbox),
    kafka: value('kafka', kafka),
    search: value('search', search),
    bulk: value('bulk', bulk),
    reindex: value('reindex', reindex),
    errors,
  };
}

export type OpsStats = Awaited<ReturnType<typeof readOps>>;
