ALTER TABLE products ADD COLUMN revision BIGINT NOT NULL DEFAULT 0;

CREATE TABLE outbox_events (
    id BIGSERIAL PRIMARY KEY,
    aggregate_id UUID NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('UPSERT', 'DELETE')),
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ
);

CREATE INDEX outbox_pending ON outbox_events (id) WHERE published_at IS NULL;
CREATE INDEX outbox_aggregate_pending
    ON outbox_events (aggregate_id, id) WHERE published_at IS NULL;
