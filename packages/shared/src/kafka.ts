import { Kafka, logLevel } from 'kafkajs';
import { config } from './config.js';

export const CATALOG_TOPIC = 'catalog.events.v1';
export const DLQ_TOPIC = 'catalog.events.dlq';

export function createKafka(clientId = 'catalog-sync'): Kafka {
  return new Kafka({
    clientId,
    brokers: config.kafkaBrokers,
    ssl: config.kafkaTls,
    sasl: config.kafkaSasl,
    logLevel: logLevel.WARN,
    retry: { initialRetryTime: 300, retries: 8 },
  });
}

export async function ensureTopics(): Promise<void> {
  if (process.env.KAFKA_CREATE_TOPICS === 'false') {
    return;
  }
  const admin = createKafka('catalog-topics').admin();
  await admin.connect();
  try {
    await admin.createTopics({
      waitForLeaders: true,
      topics: [
        { topic: CATALOG_TOPIC, numPartitions: config.kafkaPartitions },
        { topic: DLQ_TOPIC, numPartitions: config.kafkaPartitions },
      ],
    });
  } finally {
    await admin.disconnect();
  }
}

export async function readConsumerLag(): Promise<{
  topic: string;
  groupId: string;
  totalLag: number;
  partitions: { partition: number; lag: number }[];
}> {
  const admin = createKafka('catalog-lag').admin();
  await admin.connect();
  try {
    const [topicOffsets, groupOffsets] = await Promise.all([
      admin.fetchTopicOffsets(CATALOG_TOPIC),
      admin.fetchOffsets({ groupId: config.kafkaGroupId, topics: [CATALOG_TOPIC] }),
    ]);
    const committedOffsets = new Map(
      groupOffsets[0]?.partitions.map(({ partition, offset }) => [partition, BigInt(offset)])
    );
    const partitions = topicOffsets.map(({ partition, low, high }) => {
      const logStart = BigInt(low);
      const committed = committedOffsets.get(partition) ?? logStart;
      const available = BigInt(high) - (committed < logStart ? logStart : committed);
      return { partition, lag: Number(available > 0n ? available : 0n) };
    });
    return {
      topic: CATALOG_TOPIC,
      groupId: config.kafkaGroupId,
      totalLag: partitions.reduce((sum, partition) => sum + partition.lag, 0),
      partitions,
    };
  } finally {
    await admin.disconnect();
  }
}
