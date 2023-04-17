import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { burstCatalog, pool } from '@catalog-sync/shared';

const { values } = parseArgs({
  options: {
    count: { type: 'string' },
    'interval-ms': { type: 'string' },
    once: { type: 'boolean' },
  },
});
const count = Number(values.count ?? (values.once ? 500 : 50));
const interval = Number(values['interval-ms'] ?? 250);
if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(interval) || interval < 1) {
  throw new Error('count and interval-ms must be positive integers');
}

const shutdown = new AbortController();
const stop = () => shutdown.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  do {
    const { eventsQueued } = await burstCatalog(count);
    console.log(`queued ${eventsQueued} catalog events`);
    if (values.once || shutdown.signal.aborted) break;
    try {
      await delay(interval, undefined, { signal: shutdown.signal });
    } catch (error) {
      if (!shutdown.signal.aborted) throw error;
    }
  } while (!shutdown.signal.aborted);
} finally {
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  await pool.end();
}
