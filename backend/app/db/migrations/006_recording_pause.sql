PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE recordings_new (
    id TEXT NOT NULL PRIMARY KEY,

    title TEXT NOT NULL DEFAULT '录音'
        CHECK (length(trim(title)) > 0),

    status TEXT NOT NULL DEFAULT 'CREATED'
        CHECK (status IN ('CREATED', 'RECORDING', 'PAUSED', 'INTERRUPTED', 'ENDED', 'DELETED')),

    mime_type TEXT NULL,

    sample_rate INTEGER NULL
        CHECK (sample_rate IS NULL OR sample_rate > 0),

    started_at TEXT NULL,

    ended_at TEXT NULL,

    interrupted_at TEXT NULL,

    error_code TEXT NULL,

    error_message TEXT NULL,

    created_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    updated_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO recordings_new (
    id, title, status, mime_type, sample_rate, started_at, ended_at, interrupted_at,
    error_code, error_message, created_at, updated_at
)
SELECT
    id, title, status, mime_type, sample_rate, started_at, ended_at, interrupted_at,
    error_code, error_message, created_at, updated_at
FROM recordings;

DROP TABLE recordings;

ALTER TABLE recordings_new RENAME TO recordings;

CREATE INDEX IF NOT EXISTS ix_recordings_status
ON recordings(status, updated_at);

COMMIT;

PRAGMA foreign_keys = ON;
