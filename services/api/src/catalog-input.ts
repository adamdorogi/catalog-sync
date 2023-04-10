import {z} from 'zod';

export const skuInput = z.string().trim().min(1).max(100).regex(/^[a-z0-9._ /+-]+$/i);
const amount = z.number().int().nonnegative().max(2_147_483_647);
export const tierInput = z.enum(['RETAIL', 'TRADE', 'WHOLESALE']);

export const inventoryInput = z.object({
  warehouseCode: z.string().trim().regex(/^[A-Z0-9][A-Z0-9_-]{0,23}$/i).transform((value) => value.toUpperCase()),
  onHand: amount,
  reserved: amount.optional(),
}).superRefine((value, context) => {
  if ((value.reserved ?? 0) > value.onHand) {
    context.addIssue({code: 'custom', path: ['reserved'], message: 'Must be at most onHand'});
  }
});

export const tierPriceInput = z.object({
  tierCode: tierInput,
  minQty: amount.min(1),
  unitPriceCents: amount,
});

export const productInput = z.object({
  mpn: z.string().trim().max(150).optional(),
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().trim().max(8_000).optional(),
  brand: z.string().trim().min(1).max(120).optional(),
  category: z.string().trim().min(1).max(120).optional(),
  attributes: z.record(z.string().trim().min(1).max(60), z.string().trim().min(1).max(120))
    .refine((value) => Object.keys(value).length <= 32, 'At most 32 attributes are allowed').optional(),
  basePriceCents: amount.optional(),
  active: z.boolean().optional(),
  tierPrices: z.array(tierPriceInput).max(100)
    .refine((rows) => new Set(rows.map(({tierCode, minQty}) => `${tierCode}:${minQty}`)).size === rows.length,
      'Duplicate tier and minimum quantity').optional(),
}).strict();

export const productEditInput = productInput.extend({inventory: inventoryInput.optional()});
export const productCreateInput = productInput.extend({
  sku: skuInput,
  title: productInput.shape.title.unwrap(),
  brand: productInput.shape.brand.unwrap(),
  category: productInput.shape.category.unwrap(),
  basePriceCents: amount,
  inventory: z.array(inventoryInput).max(100).optional(),
});
