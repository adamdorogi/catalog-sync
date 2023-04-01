import { z } from 'zod';

const quantity = z.number().int().nonnegative().max(2147483647);
export const tierCodes = ['RETAIL', 'TRADE', 'WHOLESALE'] as const;
export const tierCodeSchema = z.enum(tierCodes);
export type TierCode = z.infer<typeof tierCodeSchema>;

export const inventorySchema = z.object({
  warehouseCode: z.string().min(1),
  onHand: quantity,
  reserved: quantity,
});

export const tierPriceSchema = z.object({
  tierCode: tierCodeSchema,
  minQty: quantity.positive(),
  unitPriceCents: quantity,
});

const revision = z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => value.length < 19 || value <= '9223372036854775807');

export const catalogDocumentSchema = z.object({
  id: z.string().uuid(),
  revision,
  sku: z.string().min(1),
  mpn: z.string(),
  title: z.string().min(1),
  description: z.string(),
  brand: z.string().min(1),
  category: z.string().min(1),
  attributes: z.record(z.string()),
  basePriceCents: quantity,
  active: z.boolean(),
  updatedAt: z.string(),
  inventory: z.array(inventorySchema),
  tierPrices: z.array(tierPriceSchema),
});

const eventFields = {
  eventId: revision.refine((value) => value !== '0'),
  productId: z.string().uuid(),
};

export const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...eventFields, type: z.literal('UPSERT'), document: catalogDocumentSchema }),
  z.object({ ...eventFields, type: z.literal('DELETE'), document: z.null() }),
]).superRefine((event, context) => {
  if (event.type === 'UPSERT' && (event.document.id !== event.productId
    || event.document.revision !== event.eventId || !event.document.active)) {
    context.addIssue({ code: 'custom', message: 'catalog document does not match event' });
  }
});

export type CatalogDocument = z.infer<typeof catalogDocumentSchema>;
export type CatalogEvent = z.infer<typeof eventSchema>;
export type TierPrice = z.infer<typeof tierPriceSchema>;

export function normalizeSku(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}
