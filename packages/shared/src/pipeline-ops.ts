import type { Producer } from 'kafkajs';
import { pool, withTransaction } from './db.js';
import { eventSchema } from './events.js';
import { CATALOG_TOPIC, createKafka, DLQ_TOPIC } from './kafka.js';

interface SourceMessage {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  payload: unknown;
}

export interface DlqMessage {
  id: string;
  sourceTopic: string;
  sourcePartition: number;
  sourceOffset: string;
  messageKey: string | null;
  payload: unknown;
  reason: string;
  status: 'PENDING' | 'REPLAYED' | 'DISCARDED';
  createdAt: string;
  resolvedAt: string | null;
}

export async function saveDlq(source: SourceMessage, reason: string, producer: Producer): Promise<void> {
  const { rows: [record] } = await pool.query<{ id: string; published: boolean }>(`
    INSERT INTO dlq_messages (source_topic, source_partition, source_offset, message_key, payload, reason)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6)
    ON CONFLICT (source_topic, source_partition, source_offset)
      DO UPDATE SET source_offset = EXCLUDED.source_offset
    RETURNING id, notification_published_at IS NOT NULL AS published
  `, [source.topic, source.partition, source.offset, source.key, JSON.stringify(source.payload), reason]);
  if (record.published) {
    return;
  }
  await producer.send({
    topic: DLQ_TOPIC,
    acks: -1,
    messages: [{
      key: source.key ?? record.id,
      value: JSON.stringify({ id: record.id, source, reason }),
    }],
  });
  await pool.query('UPDATE dlq_messages SET notification_published_at = now() WHERE id = $1', [record.id]);
}

export async function listDlq(limit = 100): Promise<DlqMessage[]> {
  const result = await pool.query<DlqMessage>(`
    SELECT id::text, source_topic AS "sourceTopic", source_partition AS "sourcePartition",
      source_offset AS "sourceOffset", message_key AS "messageKey", payload, reason,
      status, created_at AS "createdAt", resolved_at AS "resolvedAt"
    FROM dlq_messages
    ORDER BY (status = 'PENDING') DESC, id DESC
    LIMIT $1
  `, [limit]);
  return result.rows;
}

export async function replayDlq(id: string): Promise<boolean> {
  return withTransaction(async (db) => {
    const { rows: [record] } = await db.query<{ payload: unknown }>(`
      SELECT payload FROM dlq_messages WHERE id = $1 AND status = 'PENDING' FOR UPDATE
    `, [id]);
    if (!record) {
      return false;
    }
    const event = eventSchema.parse(record.payload);
    const producer = createKafka('catalog-dlq-replay').producer({ allowAutoTopicCreation: false });
    await producer.connect();
    try {
      await producer.send({
        topic: CATALOG_TOPIC,
        acks: -1,
        messages: [{ key: event.productId, value: JSON.stringify(event) }],
      });
    } finally {
      await producer.disconnect();
    }
    await db.query("UPDATE dlq_messages SET status = 'REPLAYED', resolved_at = now() WHERE id = $1", [id]);
    return true;
  });
}

export async function discardDlq(id: string): Promise<boolean> {
  const result = await pool.query(`
    UPDATE dlq_messages SET status = 'DISCARDED', resolved_at = now()
    WHERE id = $1 AND status = 'PENDING'
  `, [id]);
  return result.rowCount === 1;
}

export async function readBulkStats(): Promise<{
  docsPerSecond: number;
  p95Ms: number;
  indexedDocs: number;
  windowSeconds: number;
}> {
  const windowSeconds = 60;
  const { rows: [stats] } = await pool.query<{ indexed: string; p95: number }>(`
    SELECT coalesce(sum(indexed_count), 0) AS indexed,
      coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0) AS p95
    FROM bulk_index_samples
    WHERE created_at >= now() - ($1::int * interval '1 second')
  `, [windowSeconds]);
  const indexedDocs = Number(stats.indexed);
  return {
    docsPerSecond: indexedDocs / windowSeconds,
    p95Ms: stats.p95,
    indexedDocs,
    windowSeconds,
  };
}
