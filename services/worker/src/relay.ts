import type { Producer } from 'kafkajs';
import { withTransaction } from '@catalog-sync/shared';
import { CATALOG_TOPIC } from '@catalog-sync/shared/kafka';

export const relayBatchSql = `
  WITH batch AS MATERIALIZED (
    SELECT id, aggregate_id, payload
    FROM outbox_events
    WHERE published_at IS NULL
    ORDER BY id
    LIMIT 250
    FOR UPDATE SKIP LOCKED
  )
  SELECT b.id, b.aggregate_id, b.payload
  FROM batch b
  WHERE NOT EXISTS (
    SELECT 1
    FROM outbox_events prior
    WHERE prior.aggregate_id = b.aggregate_id
      AND prior.id < b.id AND prior.published_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM batch picked WHERE picked.id = prior.id)
  )
  ORDER BY b.id
`;

interface OutboxRow {
  id: string;
  aggregate_id: string;
  payload: unknown;
}

export async function relayBatch(producer: Producer): Promise<number> {
  return withTransaction(async (db) => {
    // A second relay can pick later rows while an earlier batch publishes.
    const { rows } = await db.query<OutboxRow>(relayBatchSql);
    if (rows.length === 0) {
      return 0;
    }
    await producer.send({
      topic: CATALOG_TOPIC,
      acks: -1,
      messages: rows.map((row) => ({
        key: row.aggregate_id,
        value: JSON.stringify(row.payload),
      })),
    });
    await db.query(
      'UPDATE outbox_events SET published_at = now() WHERE id = ANY($1::bigint[])',
      [rows.map((row) => row.id)]
    );
    return rows.length;
  });
}
