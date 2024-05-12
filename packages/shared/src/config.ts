import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function flag(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.toLowerCase();
  if (!value) return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${name} must be true or false`);
}

function kafkaSasl() {
  const username = process.env.KAFKA_SASL_USERNAME;
  const password = process.env.KAFKA_SASL_PASSWORD;
  if (!username && !password) return undefined;
  if (!username || !password) throw new Error('Kafka SASL requires a username and password');

  const mechanism = process.env.KAFKA_SASL_MECHANISM || 'plain';
  const credentials = { username, password };
  switch (mechanism) {
    case 'plain': return { mechanism, ...credentials };
    case 'scram-sha-256': return { mechanism, ...credentials };
    case 'scram-sha-512': return { mechanism, ...credentials };
    default: throw new Error('Unsupported KAFKA_SASL_MECHANISM');
  }
}

function embeddingProvider(): 'local' | 'openai' {
  const provider = process.env.EMBEDDING_PROVIDER || (process.env.OPENAI_API_KEY ? 'openai' : 'local');
  if (provider !== 'local' && provider !== 'openai') {
    throw new Error('EMBEDDING_PROVIDER must be local or openai');
  }
  if (provider === 'openai' && !process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required by the openai embedding provider');
  }
  return provider;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgres://catalog:catalog@127.0.0.1:5432/catalog',
  kafkaBrokers: (process.env.KAFKA_BROKERS || '127.0.0.1:9092').split(',').map((broker) => broker.trim()).filter(Boolean),
  kafkaTls: flag('KAFKA_TLS', false),
  kafkaSasl: kafkaSasl(),
  kafkaPartitions: integer('KAFKA_PARTITIONS', 6),
  kafkaGroupId: process.env.KAFKA_GROUP_ID || 'catalog-search-v1',
  kafkaSessionTimeout: integer('KAFKA_SESSION_TIMEOUT_MS', 30000),
  kafkaHeartbeatInterval: integer('KAFKA_HEARTBEAT_INTERVAL_MS', 3000),
  openSearchNode: process.env.OPENSEARCH_NODE || 'http://127.0.0.1:9200',
  openSearchUsername: process.env.OPENSEARCH_USERNAME,
  openSearchPassword: process.env.OPENSEARCH_PASSWORD,
  openSearchTlsRejectUnauthorized: flag('OPENSEARCH_TLS_REJECT_UNAUTHORIZED', true),
  embeddingProvider: embeddingProvider(),
  openAiApiKey: process.env.OPENAI_API_KEY,
  embeddingCacheDir: process.env.EMBEDDING_CACHE_DIR,
  port: integer('API_PORT', 4000),
  nodeEnv: process.env.NODE_ENV || 'development',
  apiAdminToken: process.env.API_ADMIN_TOKEN,
  corsOrigin: process.env.CORS_ORIGIN,
};
