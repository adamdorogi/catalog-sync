import { readFile, readdir } from 'node:fs/promises';
import { pool } from './db.js';

const migrationDirectory = new URL('../../../sql/migrations/', import.meta.url);
const migrationLock = 13370001;

export async function runMigrations(): Promise<string[]> {
  const files = (await readdir(migrationDirectory)).filter((file) => /^\d+_.*\.sql$/.test(file)).sort();
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [migrationLock]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const existing = await client.query<{ filename: string }>('SELECT filename FROM schema_migrations');
    const filenames = new Set(existing.rows.map((row) => row.filename));
    for (const file of files) {
      if (filenames.has(file)) continue;
      const sql = await readFile(new URL(file, migrationDirectory), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return applied;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [migrationLock]);
      client.release();
    } catch {
      client.release(true);
    }
  }
}
