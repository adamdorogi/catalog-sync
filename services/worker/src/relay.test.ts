import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { config } from '@catalog-sync/shared';
import { relayBatchSql } from './relay.js';

const integration = process.env.CATALOG_INTEGRATION === '1' ? it : it.skip;

integration('relays unlocked products while preserving each product sequence', async () => {
  const db = new pg.Pool({ connectionString: config.databaseUrl });
  const schema = `relay_test_${randomBytes(6).toString('hex')}`;
  const first = await db.connect();
  const second = await db.connect();
  try {
    await first.query(`CREATE SCHEMA ${schema}`);
    await first.query(`SET search_path = ${schema}`);
    await second.query(`SET search_path = ${schema}`);
    await first.query(`
      CREATE TABLE outbox_events (
        id int PRIMARY KEY, aggregate_id text NOT NULL, payload jsonb, published_at timestamptz
      );
      INSERT INTO outbox_events (id, aggregate_id) VALUES (1, 'a'), (2, 'b'), (3, 'a'), (4, 'a');
    `);
    await first.query('BEGIN');
    await first.query('SELECT id FROM outbox_events WHERE id = 1 FOR UPDATE');
    await second.query('BEGIN');
    const other = await second.query<{ id: number }>(relayBatchSql);
    expect(other.rows.map(({ id }) => id)).toEqual([2]);
    await second.query('ROLLBACK');
    await first.query('ROLLBACK');
    const all = await second.query<{ id: number }>(relayBatchSql);
    expect(all.rows.map(({ id }) => id)).toEqual([1, 2, 3, 4]);
  } finally {
    await first.query('ROLLBACK');
    await second.query('ROLLBACK');
    await first.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    first.release();
    second.release();
    await db.end();
  }
});
