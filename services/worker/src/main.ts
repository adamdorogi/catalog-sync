import { setTimeout as delay } from 'node:timers/promises';
import { config, pool, runMigrations } from '@catalog-sync/shared';
import { CATALOG_TOPIC, createKafka, ensureTopics } from '@catalog-sync/shared/kafka';
import { CATALOG_ALIAS, catalogIndexDefinition, getAliasIndices, searchClient } from '@catalog-sync/shared/search-index';
import { pino } from 'pino';
import { indexMessage } from './indexer.js';
import { relayBatch } from './relay.js';

const logger = pino({ name: 'catalog-worker' });
const stop = new AbortController();
const kafka = createKafka('catalog-worker');
const producer = kafka.producer({ allowAutoTopicCreation: false, maxInFlightRequests: 1 });
const consumer = kafka.consumer({
  groupId: config.kafkaGroupId,
  allowAutoTopicCreation: false,
  sessionTimeout: config.kafkaSessionTimeout,
  heartbeatInterval: config.kafkaHeartbeatInterval,
  maxBytes: 4 * 1024 * 1024,
  maxWaitTimeInMs: 250,
});
const { signal } = stop;


consumer.on(consumer.events.CRASH, ({ payload }) => {
  logger.error({ err: payload.error, restart: payload.restart }, 'consumer crashed');
  if (!payload.restart) {
    process.exitCode = 1;
    stop.abort();
  }
});

async function runLoop(
  name: string,
  interval: number,
  job: () => Promise<boolean>
): Promise<void> {
  while (!signal.aborted) {
    let worked = false;
    let wait = interval;
    try {
      worked = await job();
    } catch (err) {
      logger.error({ err, job: name }, 'worker loop failed');
      wait = Math.max(interval, 1000);
    }
    if (!worked && !signal.aborted) {
      await delay(wait, undefined, { signal }).catch((error: Error) => {
        if (error.name !== 'AbortError') {
          throw error;
        }
      });
    }
  }
}

async function main(): Promise<void> {
  try {
    await runMigrations();
    await ensureTopics();
    if ((await getAliasIndices()).length === 0) {
      await searchClient.indices.create({
        index: 'catalog_v_1',
        body: { ...catalogIndexDefinition, aliases: { [CATALOG_ALIAS]: { is_write_index: true } } },
      });
    }
    await producer.connect();
    await consumer.connect();
    await consumer.subscribe({ topic: CATALOG_TOPIC, fromBeginning: true });
    await consumer.run({ eachMessage: indexMessage });
    logger.info({ group: config.kafkaGroupId }, 'worker ready');
    const running = [
      runLoop('relay', 120, async () => (await relayBatch(producer)) > 0),
    ];
    const stopConsumer = new Promise<void>((resolve, reject) => {
      const disconnect = () => { void consumer.disconnect().then(resolve, reject); };
      if (signal.aborted) {
        disconnect();
      } else {
        signal.addEventListener('abort', disconnect, { once: true });
      }
    });
    try {
      await Promise.all([...running, stopConsumer]);
    } finally {
      stop.abort();
      await Promise.allSettled([...running, stopConsumer]);
    }
  } finally {
    await Promise.allSettled([consumer.disconnect(), producer.disconnect()]);
    await Promise.allSettled([pool.end(), searchClient.close()]);
  }
}

void main().catch((err: unknown) => {
  logger.error({ err }, 'worker stopped');
  process.exitCode = 1;
});
