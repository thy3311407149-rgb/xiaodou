PRAGMA foreign_keys = ON;

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS files (
    id TEXT NOT NULL PRIMARY KEY,

    user_id TEXT NOT NULL DEFAULT 'demo-user',

    file_name TEXT NOT NULL
        CHECK (length(trim(file_name)) > 0),

    file_type TEXT NOT NULL
        CHECK (file_type = 'application/pdf'),

    file_size INTEGER NOT NULL
        CHECK (file_size > 0),

    storage_path TEXT NOT NULL
        UNIQUE,

    status TEXT NOT NULL DEFAULT 'CREATED'
        CHECK (
            status IN (
                'CREATED',
                'UPLOADING',
                'UPLOADED',
                'UPLOAD_FAILED',
                'QUEUED',
                'EXTRACTING',
                'EXTRACTED',
                'EXTRACTION_FAILED',
                'SUMMARIZING',
                'COMPLETED',
                'SUMMARY_FAILED',
                'DELETED'
            )
        ),

    error_code TEXT NULL,

    error_message TEXT NULL,

    idempotency_key TEXT NULL,

    created_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    updated_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT NOT NULL PRIMARY KEY,

    file_id TEXT NOT NULL,

    task_type TEXT NOT NULL DEFAULT 'PROCESS_PDF'
        CHECK (task_type = 'PROCESS_PDF'),

    status TEXT NOT NULL DEFAULT 'QUEUED'
        CHECK (
            status IN (
                'QUEUED',
                'RUNNING',
                'SUCCEEDED',
                'FAILED'
            )
        ),

    current_step TEXT NOT NULL DEFAULT 'EXTRACT_TEXT'
        CHECK (
            current_step IN (
                'EXTRACT_TEXT',
                'SAVE_DOCUMENT_TEXT',
                'CREATE_CHUNKS',
                'GENERATE_SUMMARY',
                'SAVE_SUMMARY',
                'COMPLETED'
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

    CONSTRAINT fk_tasks_file
        FOREIGN KEY (file_id)
        REFERENCES files(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS document_texts (
    id TEXT NOT NULL PRIMARY KEY,

    file_id TEXT NOT NULL,

    page_number INTEGER NOT NULL
        CHECK (page_number >= 1),

    content TEXT NOT NULL DEFAULT '',

    created_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    CONSTRAINT uq_document_texts_file_page
        UNIQUE (file_id, page_number),

    CONSTRAINT fk_document_texts_file
        FOREIGN KEY (file_id)
        REFERENCES files(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS text_chunks (
    id TEXT NOT NULL PRIMARY KEY,

    file_id TEXT NOT NULL,

    page_number INTEGER NULL
        CHECK (page_number IS NULL OR page_number >= 1),

    chunk_index INTEGER NOT NULL
        CHECK (chunk_index >= 0),

    content TEXT NOT NULL DEFAULT '',

    token_count INTEGER NOT NULL DEFAULT 0
        CHECK (token_count >= 0),

    embedding_status TEXT NOT NULL DEFAULT 'NOT_READY'
        CHECK (
            embedding_status IN (
                'NOT_READY',
                'PENDING',
                'READY',
                'FAILED'
            )
        ),

    created_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    CONSTRAINT uq_text_chunks_file_index
        UNIQUE (file_id, chunk_index),

    CONSTRAINT fk_text_chunks_file
        FOREIGN KEY (file_id)
        REFERENCES files(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS summaries (
    id TEXT NOT NULL PRIMARY KEY,

    file_id TEXT NOT NULL,

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

    CONSTRAINT uq_summaries_task
        UNIQUE (task_id),

    CONSTRAINT fk_summaries_file
        FOREIGN KEY (file_id)
        REFERENCES files(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_summaries_task
        FOREIGN KEY (task_id)
        REFERENCES tasks(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS operation_logs (
    id TEXT NOT NULL PRIMARY KEY,

    request_id TEXT NOT NULL,

    task_id TEXT NULL,

    file_id TEXT NULL,

    operation TEXT NOT NULL
        CHECK (
            operation IN (
                'FILE_UPLOAD_STARTED',
                'FILE_UPLOAD_COMPLETED',
                'FILE_UPLOAD_FAILED',
                'FILE_DELETE_FAILED',
                'TASK_CREATED',
                'PDF_EXTRACTION_STARTED',
                'PDF_EXTRACTION_COMPLETED',
                'PDF_EXTRACTION_FAILED',
                'SUMMARY_STARTED',
                'LLM_REQUEST_STARTED',
                'LLM_REQUEST_COMPLETED',
                'LLM_REQUEST_FAILED',
                'SUMMARY_SAVED',
                'TASK_COMPLETED',
                'TASK_FAILED',
                'TASK_RETRY_CREATED'
            )
        ),

    status TEXT NOT NULL
        CHECK (
            status IN (
                'STARTED',
                'SUCCEEDED',
                'FAILED'
            )
        ),

    duration_ms INTEGER NULL
        CHECK (duration_ms IS NULL OR duration_ms >= 0),

    error_message TEXT NULL,

    created_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    CONSTRAINT fk_operation_logs_task
        FOREIGN KEY (task_id)
        REFERENCES tasks(id)
        ON DELETE SET NULL,

    CONSTRAINT fk_operation_logs_file
        FOREIGN KEY (file_id)
        REFERENCES files(id)
        ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS ix_files_user_created
ON files(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_files_status
ON files(status);

CREATE UNIQUE INDEX IF NOT EXISTS ux_files_idempotency_key
ON files(idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_tasks_file_created
ON tasks(file_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_tasks_request_id
ON tasks(request_id);

CREATE INDEX IF NOT EXISTS ix_tasks_status_updated
ON tasks(status, updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_one_active_per_file
ON tasks(file_id)
WHERE status IN ('QUEUED', 'RUNNING');

CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_idempotency_key
ON tasks(idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_text_chunks_file_page
ON text_chunks(file_id, page_number);

CREATE INDEX IF NOT EXISTS ix_summaries_file_created
ON summaries(file_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_operation_logs_request_id
ON operation_logs(request_id);

CREATE INDEX IF NOT EXISTS ix_operation_logs_file_created
ON operation_logs(file_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_operation_logs_task_created
ON operation_logs(task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_operation_logs_operation_status
ON operation_logs(operation, status);

COMMIT;
