CREATE TABLE dlq_messages (
    id BIGSERIAL PRIMARY KEY,
    source_topic TEXT NOT NULL,
    source_partition INTEGER NOT NULL,
    source_offset TEXT NOT NULL,
    message_key TEXT,
    payload JSONB NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'REPLAYED', 'DISCARDED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    notification_published_at TIMESTAMPTZ,
    UNIQUE (source_topic, source_partition, source_offset)
);

CREATE INDEX dlq_unpublished ON dlq_messages (id) WHERE notification_published_at IS NULL;
