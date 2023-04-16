import type { EachMessagePayload } from 'kafkajs';
import { eventSchema } from '@catalog-sync/shared';
import { CATALOG_ALIAS, prepareIndexWrites, searchClient } from '@catalog-sync/shared/search-index';

export async function indexMessage({ message }: EachMessagePayload): Promise<void> {
  const event = eventSchema.parse(JSON.parse(message.value?.toString('utf8') ?? 'null'));
  const [write] = await prepareIndexWrites([event]);
  await searchClient.index({ index: CATALOG_ALIAS, id: write.id, body: write.document });
}
