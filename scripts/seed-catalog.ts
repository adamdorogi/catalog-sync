import { parseArgs } from 'node:util';
import { importCatalog, pool, seedExamples, type CatalogImportRow, type ProductPatch } from '@catalog-sync/shared';

interface Family {
  part: string;
  name: string;
  category: string;
  attribute: string;
  sizes: string[];
  finishes: string[];
  base: number;
}

const families: Family[] = [
  { part: 'HXB', name: 'hex head bolt', category: 'Fasteners', attribute: 'thread',
    sizes: ['M5', 'M6', 'M8', 'M10', 'M12', 'M16', 'M20', 'M24'],
    finishes: ['Zinc Plated Steel', 'Class 8.8 Steel', '304 Stainless', 'Class 10.9 Steel'], base: 65 },
  { part: 'FWA', name: 'fender washer', category: 'Fasteners', attribute: 'diameter',
    sizes: ['5 mm', '6 mm', '8 mm', '10 mm', '12 mm', '16 mm', '20 mm'],
    finishes: ['Zinc Plated Steel', '304 Stainless', '316 Stainless', 'Galvanized Steel'], base: 18 },
  { part: 'THR', name: 'threaded rod', category: 'Fasteners', attribute: 'thread',
    sizes: ['M5', 'M6', 'M8', 'M10', 'M12', 'M16', 'M20', 'M24'],
    finishes: ['Class 4.6 Steel', 'Class 8.8 Steel', '304 Stainless', '316 Stainless'], base: 410 },
  { part: 'FLN', name: 'flange lock nut', category: 'Fasteners', attribute: 'thread',
    sizes: ['M4', 'M5', 'M6', 'M8', 'M10', 'M12', 'M14', 'M16'],
    finishes: ['Zinc Plated Steel', 'Phosphate Steel', '304 Stainless', 'Zinc Flake Steel'], base: 38 },
  { part: 'DGB', name: 'deep groove ball bearing', category: 'Bearings', attribute: 'bore',
    sizes: ['8 mm', '10 mm', '12 mm', '15 mm', '17 mm', '20 mm', '25 mm', '30 mm'],
    finishes: ['Rubber Sealed', 'Metal Shielded', 'Open', 'High Temperature'], base: 920 },
  { part: 'NRL', name: 'needle roller bearing', category: 'Bearings', attribute: 'bore',
    sizes: ['10 mm', '12 mm', '16 mm', '20 mm', '24 mm', '30 mm', '35 mm', '40 mm'],
    finishes: ['Drawn Cup', 'Machined Ring', 'Caged', 'Closed End'], base: 1330 },
  { part: 'FLG', name: 'flanged cartridge bearing', category: 'Bearings', attribute: 'bore',
    sizes: ['12 mm', '15 mm', '16 mm', '20 mm', '25 mm', '30 mm', '35 mm', '40 mm'],
    finishes: ['Two Bolt', 'Three Bolt', 'Four Bolt', 'Pressed Steel'], base: 3480 },
  { part: 'ANG', name: 'angular contact bearing', category: 'Bearings', attribute: 'bore',
    sizes: ['15 mm', '17 mm', '20 mm', '25 mm', '30 mm', '35 mm', '40 mm', '50 mm'],
    finishes: ['Single Row', 'Double Row', 'Back To Back', 'Face To Face'], base: 2680 },
  { part: 'ADP', name: 'hydraulic pipe adapter', category: 'Hydraulics', attribute: 'thread',
    sizes: ['1/8 inch', '1/4 inch', '3/8 inch', '1/2 inch', '5/8 inch', '3/4 inch', '1 inch', '1-1/4 inch'],
    finishes: ['BSPP', 'BSPT', 'NPT', 'JIC'], base: 590 },
  { part: 'CRP', name: 'hydraulic hose crimp fitting', category: 'Hydraulics', attribute: 'bore',
    sizes: ['3/16 inch', '1/4 inch', '3/8 inch', '1/2 inch', '5/8 inch', '3/4 inch', '1 inch', '1-1/4 inch'],
    finishes: ['Straight', '45 Degree', '90 Degree', 'Long Drop'], base: 850 },
  { part: 'MNF', name: 'hydraulic distribution manifold', category: 'Hydraulics', attribute: 'ports',
    sizes: ['2 Port', '3 Port', '4 Port', '5 Port', '6 Port', '8 Port', '10 Port', '12 Port'],
    finishes: ['BSPP', 'NPT', 'JIC', 'SAE O-Ring'], base: 6570 },
  { part: 'MTR', name: 'orbital hydraulic motor', category: 'Hydraulics', attribute: 'displacement',
    sizes: ['32 cc', '50 cc', '80 cc', '100 cc', '125 cc', '160 cc', '200 cc', '250 cc'],
    finishes: ['Keyed Shaft', 'Splined Shaft', 'Wheel Mount', 'Short Flange'], base: 18900 },
  { part: 'CBS', name: 'automotive cable seal', category: 'Electrical', attribute: 'diameter',
    sizes: ['1.2 mm', '1.4 mm', '1.6 mm', '1.8 mm', '2.0 mm', '2.2 mm', '2.4 mm', '2.8 mm'],
    finishes: ['Green Silicone', 'Grey Silicone', 'Red Silicone', 'Blue Silicone'], base: 15 },
  { part: 'SCR', name: 'screw mount barrier block', category: 'Electrical', attribute: 'poles',
    sizes: ['2 Pole', '3 Pole', '4 Pole', '5 Pole', '6 Pole', '8 Pole', '10 Pole', '12 Pole'],
    finishes: ['15 A', '20 A', '25 A', '30 A'], base: 275 },
  { part: 'CON', name: 'DIN rail power contactor', category: 'Electrical', attribute: 'coil',
    sizes: ['12 VDC', '24 VAC', '24 VDC', '48 VDC', '110 VAC', '120 VAC', '230 VAC', '240 VAC'],
    finishes: ['9 A', '12 A', '18 A', '25 A'], base: 2580 },
  { part: 'FHL', name: 'inline blade fuse holder', category: 'Electrical', attribute: 'current',
    sizes: ['5 A', '7.5 A', '10 A', '15 A', '20 A', '25 A', '30 A', '40 A'],
    finishes: ['ATO', 'Mini Blade', 'Low Profile Mini', 'Maxi Blade'], base: 225 },
];

const categories: Record<string, { prefix: string; brands: string[] }> = {
  Fasteners: { prefix: 'FAST', brands: ['Bayside Fasteners', 'Oxley Fixings', 'Pacific Thread', 'Redgum Hardware'] },
  Bearings: { prefix: 'BRG', brands: ['Southern Motion', 'Avon Bearings', 'Ironbark Motion', 'Pacific Drive'] },
  Hydraulics: { prefix: 'HYD', brands: ['Moreton Fluid Power', 'Riverside Hydraulics', 'Bluewater Hose', 'Gulf Fittings'] },
  Electrical: { prefix: 'ELC', brands: ['Ampway Industrial', 'Clearline Controls', 'Redgum Wiring', 'Coast Electrical'] },
};

function variant(index: number): { sku: string; product: ProductPatch } {
  const fixture = seedExamples[index];
  if (fixture) {
    const { sku, mpn, title, description, brand, category, attributes, basePriceCents } = fixture;
    return { sku, product: { mpn, title, description, brand, category, attributes, basePriceCents } };
  }

  const position = index - seedExamples.length;
  const family = families[position % families.length];
  const serial = Math.floor(position / families.length);
  const size = family.sizes[serial % family.sizes.length];
  const finishNumber = Math.floor(serial / family.sizes.length);
  const finish = family.finishes[finishNumber % family.finishes.length];
  const { prefix, brands } = categories[family.category];
  const brand = brands[Math.floor(finishNumber / family.finishes.length) % brands.length];
  const grade = Math.floor(serial / (family.sizes.length * family.finishes.length * brands.length)) + 1;
  const sizeCode = size.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const mpn = `${family.part}-${sizeCode}-${String(serial + 1).padStart(4, '0')}`;
  return {
    sku: `${prefix}-${mpn}`,
    product: {
      mpn,
      title: `${size} ${family.name}, ${finish}, series ${grade}`,
      description: `${brand} ${family.name} for industrial replacement and workshop stock. ${finish} specification, series ${grade}.`,
      brand,
      category: family.category,
      attributes: { [family.attribute]: size, specification: finish, series: String(grade) },
      basePriceCents: family.base + (serial % 41) * Math.ceil(family.base / 55),
    },
  };
}

function seedRow(index: number): CatalogImportRow {
  const { sku, product } = variant(index);
  const price = product.basePriceCents ?? 0;
  const warehouses = ['BNE-01', 'SYD-02', 'MEL-01'];
  return {
    sku,
    product: {
      ...product,
      active: true,
      tierPrices: [
        { tierCode: 'TRADE', minQty: 1, unitPriceCents: Math.round(price * 0.88) },
        { tierCode: 'WHOLESALE', minQty: 1, unitPriceCents: Math.round(price * 0.77) },
        { tierCode: 'WHOLESALE', minQty: 20, unitPriceCents: Math.round(price * 0.7) },
      ],
    },
    inventory: warehouses.map((warehouseCode, warehouse) => {
      const spread = ((index + 41) * (113 + warehouse * 7)) % 239;
      const onHand = index % 17 === 1 || spread % 13 === 0 ? 0 : spread;
      return { warehouseCode, onHand, reserved: Math.floor(onHand / (8 + warehouse)) };
    }),
  };
}

const { values } = parseArgs({ options: { count: { type: 'string' } } });
const count = Number(values.count ?? process.env.SEED_COUNT ?? 15000);
if (!Number.isSafeInteger(count) || count < 1) throw new Error('seed count must be a positive integer');

try {
  const chunkSize = 500;
  let eventsQueued = 0;
  for (let offset = 0; offset < count; offset += chunkSize) {
    const rows = Array.from({ length: Math.min(chunkSize, count - offset) }, (_, i) => seedRow(offset + i));
    const result = await importCatalog(rows);
    eventsQueued += result.eventsQueued;
  }
  console.log(`seeded ${count} SKUs, queued ${eventsQueued} events`);
} finally {
  await pool.end();
}
