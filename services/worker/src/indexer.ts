import type { EachBatchPayload, KafkaMessage, Producer } from 'kafkajs';
import { eventSchema, type CatalogEvent } from '@catalog-sync/shared';
import { saveDlq } from '@catalog-sync/shared/pipeline-ops';
import { CATALOG_ALIAS, bulkIndex, prepareIndexWrites } from '@catalog-sync/shared/search-index';

interface Source {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  payload: unknown;
}

interface Delivery {
  event: CatalogEvent;
  source: Source;
}

interface Rejection {
  source: Source;
  reason: string;
}

export function decodeMessages(
  topic: string,
  partition: number,
  messages: KafkaMessage[]
): { deliveries: Delivery[]; rejected: Rejection[] } {
  const selected = new Map<string, Delivery>();
  const rejected: Rejection[] = [];
  for (const message of messages) {
    const source: Source = {
      topic,
      partition,
      offset: message.offset,
      key: message.key?.toString('utf8') ?? null,
      payload: message.value?.toString('utf8') ?? null,
    };
    try {
      if (typeof source.payload === 'string') {
        source.payload = JSON.parse(source.payload);
      }
    } catch {
      rejected.push({ source, reason: 'invalid event JSON' });
      continue;
    }
    const parsed = eventSchema.safeParse(source.payload);
    if (!parsed.success) {
      rejected.push({ source, reason: parsed.error.message });
      continue;
    }
    const event = parsed.data;
    if (event.productId !== source.key) {
      rejected.push({ source, reason: 'message key differs from product id' });
      continue;
    }
    const previous = selected.get(event.productId);
    if (!previous || BigInt(event.eventId) >= BigInt(previous.event.eventId)) {
      selected.set(event.productId, { event, source });
    }
  }
  return { deliveries: [...selected.values()], rejected };
}

export async function indexBatch(
  payload: EachBatchPayload,
  producer: Producer,
  commit: (nextOffset: string) => Promise<void>,
  heartbeatInterval: number,
  signal: AbortSignal
): Promise<void> {
  const { batch, heartbeat, isRunning, isStale, resolveOffset } = payload;
  if (signal.aborted || !isRunning() || isStale() || batch.messages.length === 0) {
    return;
  }
  const batchStop = new AbortController();
  const abortBatch = () => batchStop.abort();
  signal.addEventListener('abort', abortBatch, { once: true });
  let heartbeatError: unknown;
  let heartbeating = false;
  const timer = setInterval(() => {
    if (heartbeatError || heartbeating) {
      return;
    }
    heartbeating = true;
    void heartbeat().catch((error: unknown) => {
      heartbeatError = error;
      batchStop.abort(error);
    }).finally(() => {
      heartbeating = false;
    });
  }, heartbeatInterval);
  timer.unref();
  try {
    const { deliveries, rejected } = decodeMessages(batch.topic, batch.partition, batch.messages);
    const writes = await prepareIndexWrites(
      deliveries.map(({ event }) => event), undefined, batchStop.signal
    );
    if (signal.aborted || !isRunning() || isStale()) {
      return;
    }
    if (heartbeatError) {
      throw heartbeatError;
    }
    const sources = new Map(deliveries.map(({ event, source }) => [event.productId, source]));
    if (writes.length > 0) {
      const live = await bulkIndex(CATALOG_ALIAS, writes);
      for (const item of live.failures) {
        rejected.push({ source: sources.get(item.id)!, reason: item.reason });
      }
    }
    for (const { source, reason } of rejected) {
      await saveDlq(source, reason, producer);
    }
    if (heartbeatError) {
      throw heartbeatError;
    }
    if (isRunning() && !isStale()) {
      await heartbeat();
      const lastOffset = batch.lastOffset();
      resolveOffset(lastOffset);
      await commit((BigInt(lastOffset) + 1n).toString());
    }
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
  } finally {
    clearInterval(timer);
    signal.removeEventListener('abort', abortBatch);
  }
}
