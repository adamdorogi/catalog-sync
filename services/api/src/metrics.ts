import type {RequestHandler} from 'express';
import {collectDefaultMetrics, Gauge, Histogram, Registry} from 'prom-client';
import {readOps} from './ops.js';

export function createMetrics() {
  const register = new Registry();
  collectDefaultMetrics({register, prefix: 'catalog_'});
  const http = new Histogram({
    name: 'catalog_http_request_duration_seconds',
    help: 'API request duration in seconds',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [register],
  });
  const values = new Gauge({
    name: 'catalog_pipeline_stat',
    help: 'Pipeline snapshot, with units identified by the stat label',
    labelNames: ['stat'],
    registers: [register],
  });
  const partitionLag = new Gauge({
    name: 'catalog_kafka_partition_lag',
    help: 'Unconsumed events by Kafka partition',
    labelNames: ['partition'],
    registers: [register],
  });

  const observe: RequestHandler = (request, response, next) => {
    const stop = http.startTimer();
    response.once('finish', () => stop({
      method: request.method,
      route: request.route?.path ?? 'unmatched',
      status: String(response.statusCode),
    }));
    next();
  };

  async function scrape() {
    const data = await readOps();
    values.reset();
    partitionLag.reset();
    const current = {
      outbox_pending: data.outboxPending,
      kafka_lag: data.kafka?.totalLag,
      opensearch_documents: data.search?.documents,
      opensearch_primary_shards: data.search?.primaryShards,
      bulk_docs_per_second: data.bulk?.docsPerSecond,
      bulk_p95_ms: data.bulk?.p95Ms,
    };
    for (const [stat, value] of Object.entries(current)) {
      if (value != null) values.set({stat}, value);
    }
    for (const {partition, lag} of data.kafka?.partitions ?? []) partitionLag.set({partition: String(partition)}, lag);
    return register.metrics();
  }

  return {contentType: register.contentType, observe, scrape};
}
