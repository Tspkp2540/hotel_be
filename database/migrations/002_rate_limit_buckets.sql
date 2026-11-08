-- Infrastructure state shared by Backend instances; does not change booking business tables.
CREATE TABLE rate_limit_buckets (
    key_hash VARCHAR(64) PRIMARY KEY,
    attempts INTEGER NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT rate_limit_key_valid CHECK (key_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT rate_limit_attempts_positive CHECK (attempts > 0)
);
CREATE INDEX rate_limit_expiry_idx ON rate_limit_buckets(expires_at);
