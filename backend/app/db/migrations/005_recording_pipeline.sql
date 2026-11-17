ALTER TABLE recordings ADD COLUMN title TEXT NULL;
ALTER TABLE recordings ADD COLUMN mime_type TEXT NULL;
ALTER TABLE recordings ADD COLUMN sample_rate INTEGER NULL;
ALTER TABLE recordings ADD COLUMN started_at TEXT NULL;
ALTER TABLE recordings ADD COLUMN ended_at TEXT NULL;
ALTER TABLE recordings ADD COLUMN interrupted_at TEXT NULL;
ALTER TABLE recordings ADD COLUMN error_code TEXT NULL;
ALTER TABLE recordings ADD COLUMN error_message TEXT NULL;
ALTER TABLE summaries ADD COLUMN recording_id TEXT NULL;

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE recordings_new (
    id TEXT NOT NULL PRIMARY KEY,

    title TEXT NOT NULL DEFAULT '录音'
        CHECK (length(trim(title)) > 0),

    status TEXT NOT NULL DEFAULT 'CREATED'
        CHECK (status IN ('CREATED', 'RECORDING', 'INTERRUPTED', 'ENDED', 'DELETED')),

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
    id,
    COALESCE(NULLIF(trim(title), ''), '录音'),
    status,
    mime_type,
    sample_rate,
    started_at,
    ended_at,
    interrupted_at,
    error_code,
    error_message,
    created_at,
    updated_at
FROM recordings;

DROP TABLE recordings;

ALTER TABLE recordings_new RENAME TO recordings;

CREATE INDEX IF NOT EXISTS ix_recordings_status
ON recordings(status, updated_at);

CREATE TABLE IF NOT EXISTS recording_audio_chunks (
    id TEXT NOT NULL PRIMARY KEY,

    recording_id TEXT NOT NULL,

    sequence INTEGER NOT NULL
        CHECK (sequence >= 0),

    storage_path TEXT NOT NULL UNIQUE,

    byte_size INTEGER NOT NULL
        CHECK (byte_size > 0),

    sha256 TEXT NOT NULL
        CHECK (length(sha256) = 64),

    mime_type TEXT NOT NULL,

    asr_status TEXT NOT NULL DEFAULT 'SKIPPED'
        CHECK (asr_status IN ('SKIPPED', 'SUCCEEDED', 'FAILED')),

    created_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    CONSTRAINT uq_recording_audio_chunks_sequence
        UNIQUE (recording_id, sequence),

    CONSTRAINT fk_recording_audio_chunks_recording
        FOREIGN KEY (recording_id)
        REFERENCES recordings(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transcript_segments (
    id TEXT NOT NULL PRIMARY KEY,

    recording_id TEXT NOT NULL,

    segment_index INTEGER NOT NULL
        CHECK (segment_index >= 0),

    audio_sequence INTEGER NULL
        CHECK (audio_sequence IS NULL OR audio_sequence >= 0),

    content TEXT NOT NULL
        CHECK (length(trim(content)) > 0),

    start_time_ms INTEGER NOT NULL
        CHECK (start_time_ms >= 0),

    end_time_ms INTEGER NOT NULL
        CHECK (end_time_ms >= start_time_ms),

    speaker_id TEXT NULL
        CHECK (speaker_id IS NULL OR length(trim(speaker_id)) > 0),

    created_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    CONSTRAINT uq_transcript_segments_index
        UNIQUE (recording_id, segment_index),

    CONSTRAINT fk_transcript_segments_recording
        FOREIGN KEY (recording_id)
        REFERENCES recordings(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS knowledge_points (
    id TEXT NOT NULL PRIMARY KEY,

    knowledge_item_id TEXT NOT NULL,

    recording_id TEXT NOT NULL,

    source_segment_id TEXT NULL,

    content TEXT NOT NULL
        CHECK (length(trim(content)) > 0),

    start_time_ms INTEGER NULL
        CHECK (start_time_ms IS NULL OR start_time_ms >= 0),

    end_time_ms INTEGER NULL
        CHECK (end_time_ms IS NULL OR end_time_ms >= 0),

    speaker_id TEXT NULL
        CHECK (speaker_id IS NULL OR length(trim(speaker_id)) > 0),

    created_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    CONSTRAINT fk_knowledge_points_item
        FOREIGN KEY (knowledge_item_id)
        REFERENCES knowledge_items(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_knowledge_points_recording
        FOREIGN KEY (recording_id)
        REFERENCES recordings(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_knowledge_points_segment
        FOREIGN KEY (source_segment_id)
        REFERENCES transcript_segments(id)
        ON DELETE SET NULL
);

CREATE TRIGGER IF NOT EXISTS trg_knowledge_points_time_order_insert
BEFORE INSERT ON knowledge_points
FOR EACH ROW
WHEN NEW.start_time_ms IS NOT NULL
  AND NEW.end_time_ms IS NOT NULL
  AND NEW.end_time_ms < NEW.start_time_ms
BEGIN
    SELECT RAISE(ABORT, 'invalid knowledge point time range');
END;

CREATE TABLE summaries_new (
    id TEXT NOT NULL PRIMARY KEY,

    file_id TEXT NULL,

    recording_id TEXT NULL,

    task_id TEXT NOT NULL,

    content TEXT NOT NULL DEFAULT '',

    key_points TEXT NOT NULL DEFAULT '[]',

    citations TEXT NOT NULL DEFAULT '[]',

    model_name TEXT NOT NULL,

    prompt_version TEXT NOT NULL,

    input_tokens INTEGER NOT NULL DEFAULT 0
        CHECK (input_tokens >= 0),

    output_tokens INTEGER NOT NULL DEFAULT 0
        CHECK (output_tokens >= 0),

    created_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    updated_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    CONSTRAINT ck_summaries_one_source
        CHECK (
            (file_id IS NOT NULL AND recording_id IS NULL)
            OR (file_id IS NULL AND recording_id IS NOT NULL)
        ),

    CONSTRAINT uq_summaries_task
        UNIQUE (task_id),

    CONSTRAINT fk_summaries_file
        FOREIGN KEY (file_id)
        REFERENCES files(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_summaries_recording
        FOREIGN KEY (recording_id)
        REFERENCES recordings(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_summaries_task
        FOREIGN KEY (task_id)
        REFERENCES tasks(id)
        ON DELETE CASCADE
);

INSERT INTO summaries_new (
    id, file_id, recording_id, task_id, content, key_points, citations, model_name, prompt_version,
    input_tokens, output_tokens, created_at, updated_at
)
SELECT
    id, file_id, recording_id, task_id, content, key_points, citations, model_name, prompt_version,
    input_tokens, output_tokens, created_at, updated_at
FROM summaries;

DROP TABLE summaries;

ALTER TABLE summaries_new RENAME TO summaries;

CREATE INDEX IF NOT EXISTS ix_summaries_file_created
ON summaries(file_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_summaries_recording_created
ON summaries(recording_id, created_at DESC);

COMMIT;

PRAGMA foreign_keys = ON;
