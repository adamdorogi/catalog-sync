import {parse} from 'csv-parse';
import {z} from 'zod';
import type {CatalogImportRow} from '@catalog-sync/shared';
import {inventoryInput, productInput, skuInput, tierPriceInput} from './catalog-input.js';
import {HttpError} from './errors.js';

const csvBoolean = z.enum(['true', 'false', '1', '0']).transform((value) => value === 'true' || value === '1');
const maxRows = 20_000;
const columns = new Set([
  'sku', 'mpn', 'title', 'description', 'brand', 'category', 'attributes', 'active', 'base_price_cents',
  'warehouse_code', 'on_hand', 'reserved', 'tier_code', 'min_qty', 'unit_price_cents',
]);

function header(values: string[]) {
  const normalized = values.map((value) => value.trim().toLowerCase());
  if (!normalized.includes('sku')) throw new HttpError(400, 'CSV requires a sku column');
  if (new Set(normalized).size !== normalized.length) throw new HttpError(400, 'CSV contains duplicate columns');
  const unknown = normalized.find((name) => !columns.has(name));
  if (unknown !== undefined) throw new HttpError(400, `Unknown CSV column: ${unknown || '(blank)'}`);
  return normalized;
}

function integer(value: string | undefined) {
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`Expected an integer, got ${value}`);
  return Number(value);
}

function rowInput({record: row}: {record: Record<string, string>}): CatalogImportRow {
  const sku = skuInput.parse(row.sku);
  const product = productInput.parse({
    mpn: row.mpn || undefined,
    title: row.title || undefined,
    description: row.description || undefined,
    brand: row.brand || undefined,
    category: row.category || undefined,
    attributes: row.attributes ? JSON.parse(row.attributes) : undefined,
    active: row.active ? csvBoolean.parse(row.active) : undefined,
    basePriceCents: integer(row.base_price_cents),
    tierPrices: row.tier_code || row.min_qty || row.unit_price_cents ? [tierPriceInput.parse({
      tierCode: row.tier_code?.toUpperCase(),
      minQty: integer(row.min_qty),
      unitPriceCents: integer(row.unit_price_cents),
    })] : undefined,
  });
  const inventory = row.warehouse_code || row.on_hand || row.reserved ? [inventoryInput.parse({
    warehouseCode: row.warehouse_code,
    onHand: integer(row.on_hand),
    reserved: integer(row.reserved),
  })] : undefined;
  return {sku, product, inventory};
}

export async function readSupplierCsv(file: Buffer) {
  const parser = parse(file, {
    bom: true,
    columns: header,
    info: true,
    max_record_size: 65_536,
    skip_empty_lines: true,
    trim: true,
  });
  const rows: CatalogImportRow[] = [];
  try {
    for await (const row of parser) {
      if (rows.length >= maxRows) throw new HttpError(400, `CSV is limited to ${maxRows} rows`);
      try {
        rows.push(rowInput(row));
      } catch (error) {
        const message = error instanceof z.ZodError
          ? error.issues.map((issue) => `${issue.path.join('.') || 'sku'} ${issue.message}`).join(', ')
          : (error as Error).message;
        throw new HttpError(400, `CSV line ${row.info.lines}: ${message}`);
      }
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, `Invalid CSV: ${(error as Error).message}`);
  }
  if (!rows.length) throw new HttpError(400, 'CSV has no data rows');
  return rows;
}
