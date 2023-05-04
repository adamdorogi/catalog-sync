import {config, pool} from '@catalog-sync/shared';
import {searchClient} from '@catalog-sync/shared/search-index';
import {createApp, logger} from './app.js';

const server = createApp().listen(config.port, () => logger.info({port: config.port}, 'api listening'));

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    void Promise.allSettled([pool.end(), searchClient.close()]).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') {
          logger.error({err: result.reason}, 'connection close failed');
          process.exitCode = 1;
        }
      }
    });
  });
  server.closeIdleConnections();
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
