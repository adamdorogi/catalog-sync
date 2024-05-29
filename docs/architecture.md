# architecture

```mermaid
flowchart LR
    ERP[Supplier CSV or edit] --> API[Express API]
    API -->|one SQL transaction| PG[(Postgres catalog and outbox)]
    PG --> Relay[Outbox relay]
    Relay -->|keyed by product ID| Kafka[(catalog.events.v1)]
    Kafka --> Bulk[eachBatch indexer]
    Bulk --> Alias[catalog_current]
    Alias --> Index[(OpenSearch catalog index)]
    Bulk --> DLQ[(Kafka DLQ and Postgres)]
    PG --> Rebuild[Reindex worker]
    Rebuild -->|build and switch alias| Index
    UI[Bootstrap console] --> API
    API -->|search and facets| Alias
```

## write path

A catalog mutation locks its product row before assigning a sequence number.
The stock, tier prices, product revision, and outbox snapshot commit together.
A separate Kafka write in the request could leave either system ahead of the
other after a crash.

```mermaid
sequenceDiagram
    participant PG as Postgres
    participant R as Relay
    participant K as Kafka
    participant C as Indexer
    participant S as OpenSearch
    R->>PG: Select pending rows FOR UPDATE SKIP LOCKED
    R->>K: Publish batch with product ID keys
    K-->>R: Broker acknowledgment
    R->>PG: Mark rows published and commit
    K->>C: Fetch partition batch
    C->>S: Coalesce by revision and send _bulk
    alt Permanent item failure
        C->>PG: Record original payload and offset
        C->>K: Publish DLQ notification
    else Retryable item failure
        C->>S: Retry failed items with backoff
    end
    C->>K: Commit next offset when the batch is covered
```

## delivery and replay

The relay skips locked rows and checks for an earlier unpublished event per
product. A crash after Kafka acknowledges can still cause a duplicate. The
indexer keeps the newest event per product and uses its revision as an external
version. A version conflict covers a duplicate or stale replay. Indexed
tombstones keep old updates from reviving deleted products.

Bulk HTTP success can include failed items. Transient errors leave the offset
uncommitted until recovered. Permanent mapping or payload errors go to the DLQ.
Replay preserves the original revision. The consumer heartbeats during long
batches and leaves the group on SIGTERM. Defaults are a 30s session timeout and
a 3s heartbeat interval.

## alias rotation

The reindex worker sets up a timestamped target, then reads products by ID in
1,000-row chunks. While that job runs, the consumer writes both the current
alias and the target. External versions settle overlap between snapshot rows
and new updates. An exclusive Postgres advisory lock pauses target selection
while the worker refreshes the new index and sends one `_aliases` request.
The old index remains available for in-flight reads and manual cleanup.

## ranking

Normalize separators for exact part matches and edge n-grams. Explicit part
matches take priority. Reciprocal rank fusion uses `1 / (60 + rank)` per list,
which avoids mixing OpenSearch BM25 and k-NN score scales. Compare modes with
the 40-query benchmark. A cached query skips repeat model inference.
