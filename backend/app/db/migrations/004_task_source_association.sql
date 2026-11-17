ALTER TABLE tasks ADD COLUMN recording_id TEXT NULL;
ALTER TABLE tasks ADD COLUMN note_id TEXT NULL;

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS recordings (
    id TEXT NOT NULL PRIMARY KEY,

    status TEXT NOT NULL DEFAULT 'CREATED'
        CHECK (status IN ('CREATED', 'DELETED')),

    created_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    updated_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS notes (
    id TEXT NOT NULL PRIMARY KEY,

    status TEXT NOT NULL DEFAULT 'CREATED'
        CHECK (status IN ('CREATED', 'DELETED')),

    created_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    updated_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE tasks_new (
    id TEXT NOT NULL PRIMARY KEY,

    file_id TEXT NULL,

    recording_id TEXT NULL,

    note_id TEXT NULL,

    task_type TEXT NOT NULL DEFAULT 'PROCESS_PDF'
        CHECK (task_type IN ('PROCESS_PDF', 'PROCESS_RECORDING', 'PROCESS_NOTE')),

    status TEXT NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),

    current_step TEXT NOT NULL DEFAULT 'EXTRACT_TEXT'
        CHECK (
            current_step IN (
                'EXTRACT_TEXT',
                'SAVE_DOCUMENT_TEXT',
                'CREATE_CHUNKS',
                'GENERATE_SUMMARY',
                'SAVE_SUMMARY',
                'COMPLETED',
                'PERSIST_AUDIO',
                'TRANSCRIBE_AUDIO',
                'SAVE_TRANSCRIPT',
                'EXTRACT_KNOWLEDGE'
            )
        ),

    progress INTEGER NOT NULL DEFAULT 0
        CHECK (progress >= 0 AND progress <= 100),

    retry_count INTEGER NOT NULL DEFAULT 0
        CHECK (retry_count >= 0),

    request_id TEXT NOT NULL,

    idempotency_key TEXT NULL,

    error_code TEXT NULL,

    error_message TEXT NULL,

    started_at TEXT NULL,

    finished_at TEXT NULL,

    created_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    updated_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    CONSTRAINT ck_tasks_source_matches_type
        CHECK (
            (task_type = 'PROCESS_PDF' AND file_id IS NOT NULL AND recording_id IS NULL AND note_id IS NULL)
            OR (task_type = 'PROCESS_RECORDING' AND file_id IS NULL AND recording_id IS NOT NULL AND note_id IS NULL)
            OR (task_type = 'PROCESS_NOTE' AND file_id IS NULL AND recording_id IS NULL AND note_id IS NOT NULL)
        ),

    CONSTRAINT fk_tasks_file
        FOREIGN KEY (file_id)
        REFERENCES files(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_tasks_recording
        FOREIGN KEY (recording_id)
        REFERENCES recordings(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_tasks_note
        FOREIGN KEY (note_id)
        REFERENCES notes(id)
        ON DELETE CASCADE
);

INSERT INTO tasks_new (
    id,
    file_id,
    recording_id,
    note_id,
    task_type,
    status,
    current_step,
    progress,
    retry_count,
    request_id,
    idempotency_key,
    error_code,
    error_message,
    started_at,
    finished_at,
    created_at,
    updated_at
)
SELECT
    id,
    file_id,
    recording_id,
    note_id,
    task_type,
    status,
    current_step,
    progress,
    retry_count,
    request_id,
    idempotency_key,
    error_code,
    error_message,
    started_at,
    finished_at,
    created_at,
    updated_at
FROM tasks;

DROP TABLE tasks;

ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX IF NOT EXISTS ix_tasks_file_created
ON tasks(file_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_tasks_request_id
ON tasks(request_id);

CREATE INDEX IF NOT EXISTS ix_tasks_status_updated
ON tasks(status, updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_one_active_per_file
ON tasks(file_id)
WHERE status IN ('QUEUED', 'RUNNING') AND file_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_one_active_per_recording
ON tasks(recording_id)
WHERE status IN ('QUEUED', 'RUNNING') AND recording_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_one_active_per_note
ON tasks(note_id)
WHERE status IN ('QUEUED', 'RUNNING') AND note_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_idempotency_key
ON tasks(idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_tasks_step_matches_type_insert
BEFORE INSERT ON tasks
FOR EACH ROW
WHEN NEW.task_type IN ('PROCESS_PDF', 'PROCESS_RECORDING', 'PROCESS_NOTE')
 AND NEW.current_step IN (
    'EXTRACT_TEXT', 'SAVE_DOCUMENT_TEXT', 'CREATE_CHUNKS', 'GENERATE_SUMMARY', 'SAVE_SUMMARY', 'COMPLETED',
    'PERSIST_AUDIO', 'TRANSCRIBE_AUDIO', 'SAVE_TRANSCRIPT', 'EXTRACT_KNOWLEDGE'
 )
 AND NOT (
    (NEW.task_type = 'PROCESS_PDF' AND NEW.current_step IN (
        'EXTRACT_TEXT', 'SAVE_DOCUMENT_TEXT', 'CREATE_CHUNKS', 'GENERATE_SUMMARY', 'SAVE_SUMMARY', 'COMPLETED'
    ))
    OR (NEW.task_type = 'PROCESS_RECORDING' AND NEW.current_step IN (
        'PERSIST_AUDIO', 'TRANSCRIBE_AUDIO', 'SAVE_TRANSCRIPT', 'GENERATE_SUMMARY', 'SAVE_SUMMARY', 'EXTRACT_KNOWLEDGE', 'COMPLETED'
    ))
    OR (NEW.task_type = 'PROCESS_NOTE' AND NEW.current_step IN (
        'GENERATE_SUMMARY', 'SAVE_SUMMARY', 'EXTRACT_KNOWLEDGE', 'COMPLETED'
    ))
)
BEGIN
    SELECT RAISE(ABORT, 'task step is not valid for task type');
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_step_matches_type_update
BEFORE UPDATE OF task_type, current_step ON tasks
FOR EACH ROW
WHEN NEW.task_type IN ('PROCESS_PDF', 'PROCESS_RECORDING', 'PROCESS_NOTE')
 AND NEW.current_step IN (
    'EXTRACT_TEXT', 'SAVE_DOCUMENT_TEXT', 'CREATE_CHUNKS', 'GENERATE_SUMMARY', 'SAVE_SUMMARY', 'COMPLETED',
    'PERSIST_AUDIO', 'TRANSCRIBE_AUDIO', 'SAVE_TRANSCRIPT', 'EXTRACT_KNOWLEDGE'
 )
 AND NOT (
    (NEW.task_type = 'PROCESS_PDF' AND NEW.current_step IN (
        'EXTRACT_TEXT', 'SAVE_DOCUMENT_TEXT', 'CREATE_CHUNKS', 'GENERATE_SUMMARY', 'SAVE_SUMMARY', 'COMPLETED'
    ))
    OR (NEW.task_type = 'PROCESS_RECORDING' AND NEW.current_step IN (
        'PERSIST_AUDIO', 'TRANSCRIBE_AUDIO', 'SAVE_TRANSCRIPT', 'GENERATE_SUMMARY', 'SAVE_SUMMARY', 'EXTRACT_KNOWLEDGE', 'COMPLETED'
    ))
    OR (NEW.task_type = 'PROCESS_NOTE' AND NEW.current_step IN (
        'GENERATE_SUMMARY', 'SAVE_SUMMARY', 'EXTRACT_KNOWLEDGE', 'COMPLETED'
    ))
)
BEGIN
    SELECT RAISE(ABORT, 'task step is not valid for task type');
END;

COMMIT;

PRAGMA foreign_keys = ON;
