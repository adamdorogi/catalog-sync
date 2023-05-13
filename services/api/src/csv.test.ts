import {describe, expect, it} from 'vitest';
import {readSupplierCsv} from './csv.js';

describe('supplier CSV', () => {
  it('reads supplier offers, warehouses, and quoted attributes', async () => {
    const csv = Buffer.from([
      '\uFEFFSKU,warehouse_code,on_hand,reserved,tier_code,min_qty,unit_price_cents,attributes',
      'FAST-M12,bne-01,8,2,trade,4,120,"{""thread"":""M12""}"',
    ].join('\r\n'));
    const rows = await readSupplierCsv(csv);
    expect(rows).toMatchObject([{
      sku: 'FAST-M12',
      product: {attributes: {thread: 'M12'}, tierPrices: [{tierCode: 'TRADE', minQty: 4, unitPriceCents: 120}]},
      inventory: [{warehouseCode: 'BNE-01', onHand: 8, reserved: 2}],
    }]);
  });

  it('rejects duplicate headers and invalid stock before writes', async () => {
    await expect(readSupplierCsv(Buffer.from('sku,SKU\nA,B'))).rejects.toThrow('duplicate columns');
    await expect(readSupplierCsv(Buffer.from('sku,warehouse_code,on_hand,reserved\nA,BNE-01,3,4')))
      .rejects.toThrow('CSV line 2: reserved Must be at most onHand');
  });

  it('reports malformed input and an empty feed', async () => {
    await expect(readSupplierCsv(Buffer.from('sku,title\nA,"missing end'))).rejects.toThrow('Invalid CSV');
    await expect(readSupplierCsv(Buffer.from('sku,title\n'))).rejects.toThrow('no data rows');
  });
});
