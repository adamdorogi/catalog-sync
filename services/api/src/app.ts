import {timingSafeEqual} from 'node:crypto';
import cors from 'cors';
import express, {type ErrorRequestHandler, type RequestHandler} from 'express';
import multer from 'multer';
import {pino} from 'pino';
import {z} from 'zod';
import {
  config, deleteProduct, getProductBySku, importCatalog, patchProduct, pool, setInventory,
} from '@catalog-sync/shared';
import {getReindexProgress, requestReindex} from '@catalog-sync/shared/reindex';
import {inventoryInput, productCreateInput, productEditInput, skuInput} from './catalog-input.js';
import {readSupplierCsv} from './csv.js';
import {HttpError, route} from './errors.js';
import {searchParams} from './search-params.js';
import {getSearchDocument, searchCatalog} from './search.js';

export const logger = pino({name: 'catalog-api', level: process.env.LOG_LEVEL || 'info'});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {fileSize: 8 * 1024 * 1024, files: 1, fields: 0, parts: 2},
});
const inventoryEdit = z.object({sku: skuInput, inventory: inventoryInput});

const readiness = route(async (_request, response) => {
  let ready = false;
  try {
    const result = await pool.query("SELECT to_regclass('outbox_events') IS NOT NULL AS ready");
    ready = Boolean(result.rows[0]?.ready);
  } catch {
    // health checks retry while postgres starts
  }
  response.status(ready ? 200 : 503).json({ok: ready});
});

const administrator: RequestHandler = (request, _response, next) => {
  if (config.apiAdminToken) {
    const expected = Buffer.from(`Bearer ${config.apiAdminToken}`);
    const presented = Buffer.from(request.get('authorization') ?? '');
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
      next(new HttpError(401, 'Valid API token required'));
      return;
    }
  }
  next();
};

const handleError: ErrorRequestHandler = (error, request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  if (error instanceof HttpError) {
    response.status(error.status).json({error: error.message});
    return;
  }
  if (error instanceof z.ZodError) {
    response.status(400).json({error: 'Invalid request', issues: error.issues});
    return;
  }
  if (error instanceof multer.MulterError) {
    response.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({error: error.message});
    return;
  }
  if (error.type === 'entity.parse.failed' || error.type === 'entity.too.large') {
    response.status(error.status).json({error: error.message});
    return;
  }
  if (error.code === '23514' || error.code === '22003') {
    response.status(400).json({error: 'Catalog values violate database constraints'});
    return;
  }
  if (error.meta?.body?.error?.type === 'index_not_found_exception') {
    response.status(503).json({error: 'Search index is being initialized'});
    return;
  }
  logger.error({err: error, method: request.method, route: request.route?.path}, 'request failed');
  response.status(500).json({error: 'Request failed'});
};

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.corsOrigin) app.use(cors({origin: config.corsOrigin}));
  app.use(express.json({limit: '512kb'}));

  app.get('/healthz', (_request, response) => response.json({ok: true}));
  app.get(['/readyz', '/api/health'], readiness);
  app.get('/api/search', route(async (request, response) => {
    response.json(await searchCatalog(searchParams.parse(request.query)));
  }));
  app.get('/api/search/documents/:id', route(async (request, response) => {
    const document = await getSearchDocument(z.string().uuid().parse(request.params.id));
    if (!document) throw new HttpError(404, 'Indexed product not found');
    response.json({document});
  }));

  app.get('/api/products/:sku', route(async (request, response) => {
    const product = await getProductBySku(skuInput.parse(request.params.sku));
    if (!product) throw new HttpError(404, 'Product not found');
    response.json({product});
  }));
  app.post('/api/products', administrator, route(async (request, response) => {
    const {sku, inventory, ...fields} = productCreateInput.parse(request.body);
    const result = await importCatalog([{sku, product: fields, inventory}]);
    const product = await getProductBySku(sku);
    response.status(201).json({product, ...result});
  }));
  app.patch('/api/products/:sku', administrator, route(async (request, response) => {
    const sku = skuInput.parse(request.params.sku);
    const {inventory, ...fields} = productEditInput.parse(request.body);
    if (!inventory && Object.keys(fields).length === 0) throw new HttpError(400, 'No fields supplied');
    const product = await patchProduct(sku, fields, inventory ? [inventory] : undefined);
    if (!product) throw new HttpError(404, 'Product not found');
    response.json({product});
  }));
  app.delete('/api/products/:sku', administrator, route(async (request, response) => {
    const product = await deleteProduct(skuInput.parse(request.params.sku));
    if (!product) throw new HttpError(404, 'Product not found');
    response.json({product});
  }));
  app.patch('/api/inventory', administrator, route(async (request, response) => {
    const body = request.body;
    const {sku, inventory} = inventoryEdit.parse({sku: body?.sku, inventory: body});
    const product = await setInventory({sku, ...inventory});
    if (!product) throw new HttpError(404, 'Product not found');
    response.json({product});
  }));
  app.post('/api/imports/csv', administrator, upload.single('file'), route(async (request, response) => {
    if (!request.file) throw new HttpError(400, 'CSV file required');
    const rows = await readSupplierCsv(request.file.buffer);
    response.json(await importCatalog(rows));
  }));

  app.post('/api/admin/reindex', administrator, route(async (_request, response) => {
    response.status(202).json({job: await requestReindex()});
  }));
  app.get('/api/admin/reindex', route(async (_request, response) => {
    response.json({job: await getReindexProgress()});
  }));
  app.use((_request, _response, next) => next(new HttpError(404, 'Route not found')));
  app.use(handleError);
  return app;
}
