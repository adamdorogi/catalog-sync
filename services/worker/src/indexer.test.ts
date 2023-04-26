import type { KafkaMessage } from 'kafkajs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogEvent } from '@catalog-sync/shared';
import { bulkIndex, prepareIndexWrites, searchClient, toBulkBody } from '@catalog-sync/shared/search-index';
import { decodeMessages } from './indexer.js';

const productId = '90108edc-4d68-4d72-a01e-d760184fd325';

function deleted(eventId: string): CatalogEvent {
  return { eventId, productId, type: 'DELETE', document: null };
}

function message(offset: string, event: CatalogEvent | string): KafkaMessage {
  return {
    key: Buffer.from(productId),
    value: Buffer.from(typeof event === 'string' ? event : JSON.stringify(event)),
    timestamp: '1715516491000',
    attributes: 0,
    offset,
    headers: {},
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('index batches', () => {
  it('coalesces by revision and preserves poison messages for the DLQ', () => {
    const result = decodeMessages('catalog.events.v1', 1, [
      message('10', deleted('9007199254740993')),
      message('11', deleted('9007199254740992')),
      message('12', '{invalid'),
    ]);
    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0].source.offset).toBe('10');
    expect(result.rejected).toMatchObject([{
      source: { offset: '12', payload: '{invalid' },
      reason: 'invalid event JSON',
    }]);
  });

  it('indexes a versioned inactive document for a deletion', async () => {
    const eventId = '9007199254740993';
    const [action, source] = toBulkBody('catalog_current', await prepareIndexWrites([deleted(eventId)]));
    expect(action).toEqual({
      index: { _index: 'catalog_current', _id: productId, version_type: 'external', version: eventId },
    });
    expect(source).toEqual({ id: productId, revision: eventId, active: false });
  });

  it('retries only transient items and ignores version conflicts', async () => {
    const mock = vi.spyOn(searchClient, 'bulk');
    mock.mockResolvedValueOnce({
      body: {
        errors: true,
        items: [
          { index: { status: 429 } },
          { index: { status: 400, error: { type: 'mapper_parsing_exception', reason: 'bad value' } } },
          { index: { status: 409, error: { type: 'version_conflict_engine_exception' } } },
        ],
      },
    } as never);
    mock.mockResolvedValueOnce({
      body: { errors: false, items: [{ index: { status: 200 } }] },
    } as never);
    const wait = vi.fn(async () => undefined);
    const result = await bulkIndex('catalog_current', ['retry', 'reject', 'stale'].map((id) => ({
      id, version: '5', document: {},
    })), wait);
    expect(result).toMatchObject({
      indexed: 1,
      failures: [{ id: 'reject', status: 400, reason: 'mapper_parsing_exception: bad value' }],
    });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[1][0]).toMatchObject({
      body: [{ index: { _id: 'retry', version: '5' } }, {}],
    });
    expect(wait).toHaveBeenCalledWith(100);
  });
});
