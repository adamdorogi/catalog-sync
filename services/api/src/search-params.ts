import {z} from 'zod';

function repeated<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (input) => input === undefined ? [] : Array.isArray(input) ? input : [input],
    z.array(schema).max(32),
  );
}

const selection = z.string().trim().min(1).max(120);
const cents = z.coerce.number().int().nonnegative().max(2_147_483_647);
const attribute = selection.refine((value) => {
  const colon = value.indexOf(':');
  return colon > 0 && Boolean(value.slice(colon + 1).trim());
}, 'Expected key:value');

export const searchParams = z.object({
  q: z.string().trim().max(250).default(''),
  sku: selection.optional(),
  mode: z.literal('lexical').default('lexical'),
  tier: z.enum(['RETAIL', 'TRADE', 'WHOLESALE']).default('RETAIL'),
  quantity: z.coerce.number().int().min(1).max(1_000_000).default(1),
  inStock: z.enum(['true', 'false', '1', '0']).default('false')
    .transform((value) => value === 'true' || value === '1'),
  facets: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  category: repeated(selection),
  brand: repeated(selection),
  warehouse: repeated(selection),
  attribute: repeated(attribute),
  minPriceCents: cents.optional(),
  maxPriceCents: cents.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).superRefine((params, context) => {
  if ((params.minPriceCents ?? 0) > (params.maxPriceCents ?? Infinity)) {
    context.addIssue({code: 'custom', path: ['maxPriceCents'], message: 'Must be at least minPriceCents'});
  }
  if (params.page * params.pageSize > 10_000) {
    context.addIssue({code: 'custom', path: ['page'], message: 'Result window is limited to 10,000 rows'});
  }
});

export type SearchParams = z.infer<typeof searchParams>;
