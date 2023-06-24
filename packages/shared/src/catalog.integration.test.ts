import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getProductBySku, importCatalog, patchProduct, setInventory } from './catalog.js';
import { pool, withTransaction } from './db.js';
import { eventSchema } from './events.js';
import { runMigrations } from './migrations.js';

const integration = process.env.CATALOG_INTEGRATION === '1' ? describe : describe.skip;

integration('catalog writes and outbox', () => {
  const prefix = `TEST-${randomUUID().toUpperCase()}`;
  const sku = `${prefix}-NUT`;

  beforeAll(async () => { await runMigrations(); });
  afterEach(async () => {
    const pattern = `${prefix}%`;
    await withTransaction(async (client) => {
      await client.query('DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id FROM products WHERE sku LIKE $1)', [pattern]);
      await client.query('DELETE FROM tier_prices WHERE product_id IN (SELECT id FROM products WHERE sku LIKE $1)', [pattern]);
      await client.query('DELETE FROM inventory WHERE product_id IN (SELECT id FROM products WHERE sku LIKE $1)', [pattern]);
      await client.query('DELETE FROM products WHERE sku LIKE $1', [pattern]);
    });
  });
  afterAll(() => pool.end());

  it('combines warehouse rows and queues one complete event per SKU', async () => {
    const result = await importCatalog([
      { sku, product: { title: 'M12 hex nut', basePriceCents: 125 },
        inventory: [{ warehouseCode: 'BNE-01', onHand: 10, reserved: 2 }] },
      { sku: sku.toLowerCase(), product: { brand: 'Test Supply' },
        inventory: [{ warehouseCode: 'SYD-02', onHand: 20 }] },
      { sku, product: {}, inventory: [{ warehouseCode: 'BNE-01', onHand: 12 }] },
    ]);
    expect(result).toEqual({ rowsUpserted: 3, eventsQueued: 1 });
    const product = await getProductBySku(sku);
    expect(product).toMatchObject({
      sku,
      title: 'M12 hex nut',
      brand: 'Test Supply',
      basePriceCents: 125,
      inventory: [
        { warehouseCode: 'BNE-01', onHand: 12, reserved: 2 },
        { warehouseCode: 'SYD-02', onHand: 20, reserved: 0 },
      ],
    });
    const { rows } = await pool.query('SELECT payload FROM outbox_events WHERE aggregate_id = $1', [product?.id]);
    expect(rows).toHaveLength(1);
    expect(eventSchema.parse(rows[0].payload)).toEqual({
      eventId: product?.revision, productId: product?.id, type: 'UPSERT', document: product,
    });
  });

  it('rolls back an import when an inventory row fails a constraint', async () => {
    await expect(importCatalog([
      { sku, product: { title: 'Hex nut' } },
      { sku: `${prefix}-BOLT`, product: { title: 'Hex bolt' },
        inventory: [{ warehouseCode: 'BNE-01', onHand: -1 }] },
    ])).rejects.toMatchObject({ code: '23514' });
    expect(await getProductBySku(sku)).toBeNull();
    expect(await getProductBySku(`${prefix}-BOLT`)).toBeNull();
  });

  it('upserts individual supplier tier breaks and lets a patch replace the schedule', async () => {
    const retail = { tierCode: 'RETAIL' as const, minQty: 1, unitPriceCents: 150 };
    const trade = { tierCode: 'TRADE' as const, minQty: 1, unitPriceCents: 125 };
    const carton = { tierCode: 'WHOLESALE' as const, minQty: 20, unitPriceCents: 90 };
    const tradeUpdate = { ...trade, unitPriceCents: 115 };
    await importCatalog([{ sku, product: { title: 'Hex nut', tierPrices: [retail, trade] } }]);
    const result = await importCatalog([
      { sku, product: { tierPrices: [tradeUpdate] } },
      { sku, product: { tierPrices: [carton] } },
    ]);
    expect(result).toEqual({ rowsUpserted: 2, eventsQueued: 1 });
    expect((await getProductBySku(sku))?.tierPrices).toEqual([retail, tradeUpdate, carton]);

    expect((await patchProduct(sku, { tierPrices: [trade] }))?.tierPrices).toEqual([trade]);
    expect((await patchProduct(sku, { tierPrices: [] }))?.tierPrices).toEqual([]);
  });

  it('serializes concurrent stock and price edits and rolls back failed edits', async () => {
    await importCatalog([{ sku, product: { title: 'Hex nut', basePriceCents: 125 } }]);
    await Promise.all([
      patchProduct(sku, { basePriceCents: 200 }),
      setInventory({ sku, warehouseCode: 'BNE-01', onHand: 21 }),
    ]);

    const product = await getProductBySku(sku);
    expect(product).toMatchObject({ basePriceCents: 200, inventory: [{ onHand: 21 }] });
    await expect(patchProduct(sku, { basePriceCents: 999 }, [
      { warehouseCode: 'BNE-01', onHand: -2 },
    ])).rejects.toMatchObject({ code: '23514' });
    expect(await getProductBySku(sku)).toEqual(product);

    const { rows } = await pool.query('SELECT id, payload FROM outbox_events WHERE aggregate_id = $1 ORDER BY id', [product?.id]);
    expect(rows).toHaveLength(3);
    expect(rows[2].id).toBe(product?.revision);
    expect(eventSchema.parse(rows[2].payload)).toMatchObject({ document: product });
  });
});
