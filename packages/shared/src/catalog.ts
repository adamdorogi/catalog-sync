import { pool, withTransaction, type Queryable } from './db.js';
import type { CatalogDocument, CatalogEvent, TierPrice } from './events.js';

export type { CatalogDocument, CatalogEvent, TierPrice } from './events.js';

export type ProductPatch = Partial<Pick<CatalogDocument,
  'mpn' | 'title' | 'description' | 'brand' | 'category' | 'attributes' | 'basePriceCents' | 'active'>>
  & { tierPrices?: TierPrice[] };

export interface InventoryInput {
  warehouseCode: string;
  onHand: number;
  reserved?: number;
}

export interface CatalogImportRow {
  sku: string;
  product: ProductPatch;
  inventory?: InventoryInput[];
}

interface MergedRow {
  product: ProductPatch;
  inventory: Map<string, InventoryInput>;
  prices?: Map<string, TierPrice>;
}

const documentFields = `
  SELECT p.id, p.revision::text, p.sku, p.mpn, p.title, p.description,
         p.brand, p.category, p.attributes, p.base_price_cents AS "basePriceCents",
         p.active, to_jsonb(p.updated_at) AS "updatedAt",
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'warehouseCode', i.warehouse_code,
             'onHand', i.on_hand,
             'reserved', i.reserved
           ) ORDER BY i.warehouse_code)
           FROM inventory i WHERE i.product_id = p.id
         ), '[]') AS inventory,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'tierCode', t.tier_code,
             'minQty', t.min_qty,
             'unitPriceCents', t.unit_price_cents
           ) ORDER BY t.tier_code, t.min_qty)
           FROM tier_prices t WHERE t.product_id = p.id
         ), '[]') AS "tierPrices"
  FROM products p
`;

function catalogSku(sku: string): string {
  return sku.trim().toUpperCase();
}

export async function getProductBySku(sku: string): Promise<CatalogDocument | null> {
  const result = await pool.query<CatalogDocument>(`${documentFields} WHERE p.sku = $1`, [catalogSku(sku)]);
  return result.rows[0] ?? null;
}

export async function readCatalogPage(
  client: Queryable, cursor: string | null, limit: number,
): Promise<CatalogDocument[]> {
  const result = await client.query<CatalogDocument>(`
    ${documentFields}
    WHERE p.id > COALESCE($1::uuid, '00000000-0000-0000-0000-000000000000')
    ORDER BY p.id
    LIMIT $2
  `, [cursor, limit]);
  return result.rows;
}

function mergeImportRows(rows: CatalogImportRow[]): CatalogImportRow[] {
  const grouped = new Map<string, MergedRow>();
  for (const row of rows) {
    const sku = catalogSku(row.sku);
    let entry = grouped.get(sku);
    if (!entry) {
      entry = { product: {}, inventory: new Map() };
      grouped.set(sku, entry);
    }
    const { tierPrices, ...otherFields } = row.product;
    const supplied = Object.entries(otherFields).filter(([, value]) => value !== undefined);
    Object.assign(entry.product, Object.fromEntries(supplied));
    if (tierPrices) {
      entry.prices ??= new Map();
      for (const item of tierPrices) {
        entry.prices.set(`${item.tierCode}:${item.minQty}`, item);
      }
    }
    for (const item of row.inventory ?? []) {
      const warehouseCode = item.warehouseCode.trim().toUpperCase();
      const reserved = item.reserved ?? entry.inventory.get(warehouseCode)?.reserved;
      entry.inventory.set(warehouseCode, { ...item, warehouseCode, reserved });
    }
  }

  return [...grouped].sort(([left], [right]) => (left < right ? -1 : Number(left > right)))
    .map(([sku, { product, inventory, prices }]) => {
      if (prices) product.tierPrices = [...prices.values()];
      return { sku, product, inventory: [...inventory.values()] };
    });
}

async function writeProducts(client: Queryable, rows: CatalogImportRow[]): Promise<string[]> {
  const products = rows.map(({ sku, product }) => ({ sku, patch: product }));
  const result = await client.query<{ id: string }>(`
    UPDATE products p SET
      mpn = COALESCE(input.patch->>'mpn', p.mpn),
      title = COALESCE(input.patch->>'title', p.title),
      description = COALESCE(input.patch->>'description', p.description),
      brand = COALESCE(input.patch->>'brand', p.brand),
      category = COALESCE(input.patch->>'category', p.category),
      attributes = COALESCE(input.patch->'attributes', p.attributes),
      base_price_cents = COALESCE((input.patch->>'basePriceCents')::int, p.base_price_cents),
      active = COALESCE((input.patch->>'active')::boolean, p.active),
      revision = nextval('outbox_events_id_seq'),
      updated_at = clock_timestamp()
    FROM jsonb_to_recordset($1) AS input(sku text, patch jsonb)
    WHERE p.sku = input.sku
    RETURNING p.id
  `, [JSON.stringify(products)]);
  return result.rows.map(({ id }) => id);
}

async function writeInventory(client: Queryable, rows: CatalogImportRow[]): Promise<void> {
  const updates = rows.flatMap(({ sku, inventory }) => (inventory ?? []).map((item) => ({
    sku,
    warehouse_code: item.warehouseCode,
    on_hand: item.onHand,
    reserved: item.reserved,
  })));
  if (!updates.length) return;

  await client.query(`
    INSERT INTO inventory (product_id, warehouse_code, on_hand, reserved, updated_at)
    SELECT p.id, input.warehouse_code, input.on_hand,
           COALESCE(input.reserved, old.reserved, 0), clock_timestamp()
    FROM jsonb_to_recordset($1) AS input(sku text, warehouse_code text, on_hand int, reserved int)
    JOIN products p ON p.sku = input.sku
    LEFT JOIN inventory old ON old.product_id = p.id AND old.warehouse_code = input.warehouse_code
    ON CONFLICT (product_id, warehouse_code) DO UPDATE
    SET on_hand = EXCLUDED.on_hand, reserved = EXCLUDED.reserved, updated_at = EXCLUDED.updated_at
  `, [JSON.stringify(updates)]);
}

async function writeTiers(client: Queryable, rows: CatalogImportRow[], replace: boolean): Promise<void> {
  const withPrices = rows.filter(({ product }) => product.tierPrices !== undefined);
  if (!withPrices.length) return;

  if (replace) {
    await client.query(`
      DELETE FROM tier_prices t USING products p
      WHERE t.product_id = p.id AND p.sku = ANY($1::text[])
    `, [withPrices.map(({ sku }) => sku)]);
  }

  const prices = withPrices.flatMap(({ sku, product }) => (product.tierPrices ?? []).map((item) => ({
    sku,
    tier_code: item.tierCode,
    min_qty: item.minQty,
    unit_price_cents: item.unitPriceCents,
  })));
  if (!prices.length) return;

  await client.query(`
    INSERT INTO tier_prices (product_id, tier_code, min_qty, unit_price_cents)
    SELECT p.id, input.tier_code, input.min_qty, input.unit_price_cents
    FROM jsonb_to_recordset($1) AS input(sku text, tier_code text, min_qty int, unit_price_cents int)
    JOIN products p ON p.sku = input.sku
    ON CONFLICT (product_id, tier_code, min_qty) DO UPDATE
    SET unit_price_cents = EXCLUDED.unit_price_cents
  `, [JSON.stringify(prices)]);
}

async function queueEvents(client: Queryable, ids: string[]): Promise<CatalogDocument[]> {
  const result = await client.query<CatalogDocument>(`${documentFields} WHERE p.id = ANY($1::uuid[])`, [ids]);
  const events = result.rows.map((document): CatalogEvent => {
    const metadata = { eventId: document.revision, productId: document.id };
    return document.active
      ? { ...metadata, type: 'UPSERT', document }
      : { ...metadata, type: 'DELETE', document: null };
  });

  await client.query(`
    INSERT INTO outbox_events (id, aggregate_id, event_type, payload)
    SELECT (event->>'eventId')::bigint, (event->>'productId')::uuid, event->>'type', event
    FROM jsonb_array_elements($1) AS feed(event)
  `, [JSON.stringify(events)]);
  return result.rows;
}

async function writeCatalog(client: Queryable, rows: CatalogImportRow[], replaceTiers = false): Promise<CatalogDocument[]> {
  if (!rows.length) return [];
  const ids = await writeProducts(client, rows);
  await writeInventory(client, rows);
  await writeTiers(client, rows, replaceTiers);
  return queueEvents(client, ids);
}

export async function importCatalog(rows: CatalogImportRow[]): Promise<{ rowsUpserted: number; eventsQueued: number }> {
  const merged = mergeImportRows(rows);
  return withTransaction(async (client) => {
    const chunkSize = 500;
    for (let offset = 0; offset < merged.length; offset += chunkSize) {
      const chunk = merged.slice(offset, offset + chunkSize);
      await client.query(`
        INSERT INTO products (sku, title)
        SELECT sku, sku FROM unnest($1::text[]) AS input(sku) ORDER BY sku COLLATE "C"
        ON CONFLICT (sku) DO UPDATE SET sku = EXCLUDED.sku
      `, [chunk.map(({ sku }) => sku)]);
      await writeCatalog(client, chunk);
    }
    return { rowsUpserted: rows.length, eventsQueued: merged.length };
  });
}

export async function patchProduct(
  sku: string, product: ProductPatch, inventory?: InventoryInput[],
): Promise<CatalogDocument | null> {
  const [row] = mergeImportRows([{ sku, product, inventory }]);
  return withTransaction(async (client) => {
    const locked = await client.query('SELECT id FROM products WHERE sku = $1 FOR UPDATE', [row.sku]);
    if (!locked.rows.length) return null;
    const [result] = await writeCatalog(client, [row], true);
    return result;
  });
}

export function setInventory({ sku, ...inventory }: InventoryInput & { sku: string }): Promise<CatalogDocument | null> {
  return patchProduct(sku, {}, [inventory]);
}

export function deleteProduct(sku: string): Promise<CatalogDocument | null> {
  return patchProduct(sku, { active: false });
}

export async function burstCatalog(count: number): Promise<{ eventsQueued: number }> {
  if (!Number.isSafeInteger(count) || count <= 0) throw new RangeError('count must be a positive integer');
  return withTransaction(async (client) => {
    const locked = await client.query<{ id: string }>(`
      SELECT p.id FROM products p
      WHERE p.active AND p.id IN (SELECT id FROM products WHERE active ORDER BY random() LIMIT $1)
      ORDER BY p.sku COLLATE "C"
      FOR UPDATE
    `, [count]);
    const selected = await client.query<{ sku: string; base_price_cents: number; on_hand: number }>(`
      SELECT p.sku, p.base_price_cents, COALESCE(i.on_hand, 0) AS on_hand
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_code = 'BNE-01'
      WHERE p.id = ANY($1::uuid[])
    `, [locked.rows.map(({ id }) => id)]);
    const rows = selected.rows.map((row): CatalogImportRow => ({
      sku: row.sku,
      product: { basePriceCents: row.base_price_cents < 2147483647 ? row.base_price_cents + 1 : 0 },
      inventory: [{ warehouseCode: 'BNE-01', onHand: row.on_hand < 2147483647 ? row.on_hand + 1 : 0 }],
    }));
    return { eventsQueued: (await writeCatalog(client, rows)).length };
  });
}
