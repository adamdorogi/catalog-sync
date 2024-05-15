import type { PoolClient } from 'pg';
import { readCatalogPage } from './catalog.js';
import { pool, withTransaction } from './db.js';
import type { CatalogDocument, CatalogEvent } from './events.js';
import {
  bulkIndex,
  CATALOG_ALIAS,
  catalogIndexDefinition,
  getAliasIndices,
  prepareIndexWrites,
  readSearchEmbeddings,
  searchClient,
} from './search-index.js';

const writeLock = 82_716_001;
const jobLock = 82_716_002;
const pageSize = 1000;

export interface ReindexJob {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  targetIndex: string | null;
  processed: number;
  total: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

const jobColumns = `
  id::text, status, target_index AS "targetIndex", processed, total, error,
  created_at AS "createdAt", finished_at AS "finishedAt"
`;

async function lockWrites(db: PoolClient): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock($1)', [writeLock]);
}

export async function readWriteTargets(db: PoolClient): Promise<string[]> {
  await db.query('SELECT pg_advisory_xact_lock_shared($1)', [writeLock]);
  const { rows: [active] } = await db.query<{ target_index: string }>(`
    SELECT target_index FROM reindex_jobs WHERE status = 'RUNNING'
  `);
  return active ? [CATALOG_ALIAS, active.target_index] : [CATALOG_ALIAS];
}

export async function failIndexTarget(db: PoolClient, index: string, reason: string): Promise<void> {
  await db.query(`
    UPDATE reindex_jobs SET status = 'FAILED', finished_at = now(), error = $2
    WHERE target_index = $1 AND status = 'RUNNING'
  `, [index, reason.slice(0, 2048)]);
}

export async function ensureCatalogIndex(): Promise<void> {
  await withTransaction(async (db) => {
    await lockWrites(db);
    if ((await getAliasIndices()).length === 0) {
      await searchClient.indices.create({
        index: `catalog_v_${Date.now()}_initial`,
        body: {
          ...catalogIndexDefinition,
          aliases: { [CATALOG_ALIAS]: { is_write_index: true } },
        },
      });
    }
  });
}

export async function requestReindex(): Promise<ReindexJob> {
  return withTransaction(async (db) => {
    const created = await db.query<ReindexJob>(`
      INSERT INTO reindex_jobs DEFAULT VALUES ON CONFLICT DO NOTHING RETURNING ${jobColumns}
    `);
    if (created.rows[0]) {
      return created.rows[0];
    }
    const existing = await db.query<ReindexJob>(`
      SELECT ${jobColumns} FROM reindex_jobs ORDER BY id DESC LIMIT 1
    `);
    return existing.rows[0];
  });
}

export async function getReindexProgress(): Promise<ReindexJob | null> {
  const { rows } = await pool.query<ReindexJob>(`
    SELECT ${jobColumns} FROM reindex_jobs ORDER BY id DESC LIMIT 1
  `);
  return rows[0] ?? null;
}

async function startJob(job: ReindexJob, index: string): Promise<void> {
  const exists = await searchClient.indices.exists({ index });
  if (!exists.body) {
    await searchClient.indices.create({ index, body: catalogIndexDefinition });
  }
  await withTransaction(async (db) => {
    await lockWrites(db);
    await db.query(`
      UPDATE reindex_jobs
      SET status = 'RUNNING', target_index = $2, total = (SELECT count(*) FROM products)
      WHERE id = $1 AND status = 'QUEUED'
    `, [job.id, index]);
  });
}

async function finishJob(jobId: string, index: string, processed: number): Promise<void> {
  await withTransaction(async (db) => {
    await lockWrites(db);
    const { rows: [job] } = await db.query<{ status: string }>(`
      SELECT status FROM reindex_jobs WHERE id = $1 FOR UPDATE
    `, [jobId]);
    if (job.status !== 'RUNNING') {
      return;
    }
    const old = await getAliasIndices();
    if (!old.includes(index)) {
      await searchClient.indices.refresh({ index });
      await searchClient.indices.updateAliases({
        body: {
          actions: [
            ...old.map((previous) => ({ remove: { index: previous, alias: CATALOG_ALIAS } })),
            { add: { index, alias: CATALOG_ALIAS, is_write_index: true } },
          ],
        },
      });
    }
    await db.query(`
      UPDATE reindex_jobs
      SET status = 'SUCCEEDED', processed = $2, total = $2, finished_at = now()
      WHERE id = $1
    `, [jobId, processed]);
  });
}

async function rebuild(job: ReindexJob, signal: AbortSignal): Promise<void> {
  const index = job.targetIndex ?? `catalog_v_${new Date(job.createdAt).getTime()}_${job.id}`;
  if (job.status === 'QUEUED') {
    await startJob(job, index);
  }
  // Alias changes and the database job update are separate. Resume after a worker restart.
  if ((await getAliasIndices()).includes(index)) {
    await finishJob(job.id, index, job.processed);
    return;
  }
  let cursor: string | null = null;
  let processed = 0;
  for (;;) {
    signal.throwIfAborted();
    const documents: CatalogDocument[] = await readCatalogPage(pool, cursor, pageSize);
    if (documents.length === 0) {
      break;
    }
    const events = documents.map<CatalogEvent>((doc) => {
      const id = { eventId: doc.revision, productId: doc.id };
      return doc.active
        ? { ...id, type: 'UPSERT', document: doc }
        : { ...id, type: 'DELETE', document: null };
    });
    const existing = await readSearchEmbeddings(documents);
    const result = await bulkIndex(index, await prepareIndexWrites(events, existing, signal));
    if (result.failures.length > 0) {
      throw new Error(result.failures[0].reason);
    }
    processed += documents.length;
    const progress = await pool.query(`
      UPDATE reindex_jobs SET processed = $2, total = greatest(total, $2)
      WHERE id = $1 AND status = 'RUNNING'
    `, [job.id, processed]);
    if (progress.rowCount === 0) {
      return;
    }
    cursor = documents[documents.length - 1].id;
  }
  await finishJob(job.id, index, processed);
}

export async function runReindexJob(signal: AbortSignal): Promise<boolean> {
  const owner = await pool.connect();
  let acquired = false;
  try {
    const lock = await owner.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock($1) AS acquired', [jobLock]);
    acquired = lock.rows[0].acquired;
    if (!acquired) {
      return false;
    }
    const { rows: [job] } = await owner.query<ReindexJob>(`
      SELECT ${jobColumns} FROM reindex_jobs WHERE status IN ('QUEUED', 'RUNNING') ORDER BY id LIMIT 1
    `);
    if (!job) {
      return false;
    }
    try {
      await rebuild(job, signal);
    } catch (error) {
      if (signal.aborted) {
        return false;
      }
      const index = job.targetIndex ?? `catalog_v_${new Date(job.createdAt).getTime()}_${job.id}`;
      if ((await getAliasIndices()).includes(index)) {
        const current = await getReindexProgress();
        await finishJob(job.id, index, current?.processed ?? job.processed);
        return true;
      }
      const reason = error instanceof Error ? error.message : String(error);
      await pool.query(`
        UPDATE reindex_jobs SET status = 'FAILED', error = $2, finished_at = now()
        WHERE id = $1 AND status IN ('QUEUED', 'RUNNING')
      `, [job.id, reason.slice(0, 2048)]);
    }
    return true;
  } finally {
    try {
      if (acquired) {
        await owner.query('SELECT pg_advisory_unlock($1)', [jobLock]);
      }
      owner.release();
    } catch (error) {
      owner.release(true);
      throw error;
    }
  }
}
