PRAGMA foreign_keys = ON;

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS knowledge_items (
    id TEXT NOT NULL PRIMARY KEY,

    source_type TEXT NOT NULL
        CHECK (source_type IN ('PDF', 'RECORDING', 'NOTE')),

    source_id TEXT NOT NULL
        CHECK (length(trim(source_id)) > 0),

    title TEXT NOT NULL
        CHECK (length(trim(title)) > 0),

    status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'DELETED')),

    created_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    updated_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_items_source
ON knowledge_items(source_type, source_id);

CREATE INDEX IF NOT EXISTS ix_knowledge_items_status
ON knowledge_items(status, updated_at);

CREATE TRIGGER IF NOT EXISTS trg_knowledge_items_require_pdf_file_insert
BEFORE INSERT ON knowledge_items
FOR EACH ROW
WHEN NEW.source_type = 'PDF'
BEGIN
    SELECT RAISE(ABORT, 'PDF source file not found')
    WHERE (SELECT id FROM files WHERE id = NEW.source_id) IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_knowledge_items_require_pdf_file_update
BEFORE UPDATE OF source_type, source_id ON knowledge_items
FOR EACH ROW
WHEN NEW.source_type = 'PDF'
BEGIN
    SELECT RAISE(ABORT, 'PDF source file not found')
    WHERE (SELECT id FROM files WHERE id = NEW.source_id) IS NULL;
END;

INSERT INTO knowledge_items (
    id,
    source_type,
    source_id,
    title,
    status,
    created_at,
    updated_at
)
SELECT
    lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6))),
    'PDF',
    files.id,
    files.file_name,
    CASE WHEN files.status = 'DELETED' THEN 'DELETED' ELSE 'ACTIVE' END,
    files.created_at,
    files.updated_at
FROM files
WHERE NOT EXISTS (
    SELECT 1
    FROM knowledge_items
    WHERE knowledge_items.source_type = 'PDF'
      AND knowledge_items.source_id = files.id
);

CREATE TABLE IF NOT EXISTS knowledge_item_summaries (
    knowledge_item_id TEXT NOT NULL PRIMARY KEY,

    summary_id TEXT NOT NULL,

    created_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    updated_at TEXT NOT NULL
        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    CONSTRAINT uq_knowledge_item_summaries_summary
        UNIQUE (summary_id),

    CONSTRAINT fk_knowledge_item_summaries_item
        FOREIGN KEY (knowledge_item_id)
        REFERENCES knowledge_items(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_knowledge_item_summaries_summary
        FOREIGN KEY (summary_id)
        REFERENCES summaries(id)
        ON DELETE CASCADE
);

INSERT INTO knowledge_item_summaries (
    knowledge_item_id,
    summary_id,
    created_at,
    updated_at
)
SELECT
    knowledge_items.id,
    latest_summary.id,
    latest_summary.created_at,
    latest_summary.updated_at
FROM knowledge_items
JOIN summaries AS latest_summary
    ON latest_summary.id = (
        SELECT summaries.id
        FROM summaries
        WHERE summaries.file_id = knowledge_items.source_id
        ORDER BY summaries.created_at DESC, summaries.id DESC
        LIMIT 1
    )
WHERE knowledge_items.source_type = 'PDF'
  AND NOT EXISTS (
      SELECT 1
      FROM knowledge_item_summaries
      WHERE knowledge_item_summaries.knowledge_item_id = knowledge_items.id
  );

ALTER TABLE text_chunks ADD COLUMN start_time INTEGER NULL CHECK (start_time IS NULL OR start_time >= 0);
ALTER TABLE text_chunks ADD COLUMN end_time INTEGER NULL CHECK (end_time IS NULL OR end_time >= 0);
ALTER TABLE text_chunks ADD COLUMN speaker_id TEXT NULL CHECK (speaker_id IS NULL OR length(trim(speaker_id)) > 0);
ALTER TABLE text_chunks ADD COLUMN note_id TEXT NULL CHECK (note_id IS NULL OR length(trim(note_id)) > 0);

CREATE TRIGGER IF NOT EXISTS trg_text_chunks_time_order_insert
BEFORE INSERT ON text_chunks
FOR EACH ROW
WHEN NEW.start_time IS NOT NULL
  AND NEW.end_time IS NOT NULL
  AND NEW.end_time < NEW.start_time
BEGIN
    SELECT RAISE(ABORT, 'invalid chunk time range');
END;

CREATE TRIGGER IF NOT EXISTS trg_text_chunks_time_order_update
BEFORE UPDATE OF start_time, end_time ON text_chunks
FOR EACH ROW
WHEN NEW.start_time IS NOT NULL
  AND NEW.end_time IS NOT NULL
  AND NEW.end_time < NEW.start_time
BEGIN
    SELECT RAISE(ABORT, 'invalid chunk time range');
END;

COMMIT;
