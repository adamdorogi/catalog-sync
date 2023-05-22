CREATE TABLE bulk_index_samples (
    id BIGSERIAL PRIMARY KEY,
    indexed_count INTEGER NOT NULL CHECK (indexed_count >= 0),
    duration_ms DOUBLE PRECISION NOT NULL CHECK (duration_ms >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX bulk_index_samples_recent ON bulk_index_samples (created_at);

CREATE TABLE reindex_jobs (
    id BIGSERIAL PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
    target_index TEXT,
    processed INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX reindex_active_job ON reindex_jobs ((TRUE))
    WHERE status IN ('QUEUED', 'RUNNING');
