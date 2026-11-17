ALTER TABLE notes ADD COLUMN title TEXT NOT NULL DEFAULT '';

ALTER TABLE notes ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(tags_json) AND json_type(tags_json) = 'array');

ALTER TABLE notes ADD COLUMN body_html TEXT NOT NULL DEFAULT '';

ALTER TABLE notes ADD COLUMN body_text TEXT NOT NULL DEFAULT '';

ALTER TABLE notes ADD COLUMN create_request_id TEXT NULL
    CHECK (create_request_id IS NULL OR length(trim(create_request_id)) > 0);

ALTER TABLE notes ADD COLUMN create_request_hash TEXT NULL
    CHECK (
        create_request_hash IS NULL
        OR (
            length(create_request_hash) = 64
            AND create_request_hash NOT GLOB '*[^0-9a-f]*'
        )
    );

CREATE UNIQUE INDEX IF NOT EXISTS ux_notes_create_request_id
ON notes(create_request_id)
WHERE create_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_notes_status_updated
ON notes(status, updated_at);

CREATE TRIGGER IF NOT EXISTS trg_notes_title_insert
BEFORE INSERT ON notes
FOR EACH ROW
WHEN length(trim(NEW.title)) = 0
BEGIN
    SELECT RAISE(ABORT, 'note title is required');
END;

CREATE TRIGGER IF NOT EXISTS trg_notes_title_update
BEFORE UPDATE OF title ON notes
FOR EACH ROW
WHEN length(trim(NEW.title)) = 0
BEGIN
    SELECT RAISE(ABORT, 'note title is required');
END;

CREATE TRIGGER IF NOT EXISTS trg_notes_tags_insert
BEFORE INSERT ON notes
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'invalid note tags')
    WHERE json_type(NEW.tags_json) != 'array'
       OR EXISTS (
            SELECT 1
            FROM json_each(NEW.tags_json)
            WHERE json_each.type != 'text'
               OR json_each.value NOT IN ('TODO', 'IDEA', 'WORK')
       )
       OR (
            SELECT COUNT(*) FROM json_each(NEW.tags_json)
       ) != (
            SELECT COUNT(DISTINCT json_each.value) FROM json_each(NEW.tags_json)
       );
END;

CREATE TRIGGER IF NOT EXISTS trg_notes_tags_update
BEFORE UPDATE OF tags_json ON notes
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'invalid note tags')
    WHERE json_type(NEW.tags_json) != 'array'
       OR EXISTS (
            SELECT 1
            FROM json_each(NEW.tags_json)
            WHERE json_each.type != 'text'
               OR json_each.value NOT IN ('TODO', 'IDEA', 'WORK')
       )
       OR (
            SELECT COUNT(*) FROM json_each(NEW.tags_json)
       ) != (
            SELECT COUNT(DISTINCT json_each.value) FROM json_each(NEW.tags_json)
       );
END;

CREATE TRIGGER IF NOT EXISTS trg_notes_create_request_insert
BEFORE INSERT ON notes
FOR EACH ROW
WHEN (NEW.create_request_id IS NULL) <> (NEW.create_request_hash IS NULL)
BEGIN
    SELECT RAISE(ABORT, 'note create request id and hash must be stored together');
END;

CREATE TRIGGER IF NOT EXISTS trg_notes_create_request_update
BEFORE UPDATE OF create_request_id, create_request_hash ON notes
FOR EACH ROW
WHEN (NEW.create_request_id IS NULL) <> (NEW.create_request_hash IS NULL)
BEGIN
    SELECT RAISE(ABORT, 'note create request id and hash must be stored together');
END;

CREATE TRIGGER IF NOT EXISTS trg_knowledge_items_require_note_insert
BEFORE INSERT ON knowledge_items
FOR EACH ROW
WHEN NEW.source_type = 'NOTE'
BEGIN
    SELECT RAISE(ABORT, 'NOTE source note not found')
    WHERE (SELECT id FROM notes WHERE id = NEW.source_id) IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_knowledge_items_require_note_update
BEFORE UPDATE OF source_type, source_id ON knowledge_items
FOR EACH ROW
WHEN NEW.source_type = 'NOTE'
BEGIN
    SELECT RAISE(ABORT, 'NOTE source note not found')
    WHERE (SELECT id FROM notes WHERE id = NEW.source_id) IS NULL;
END;
