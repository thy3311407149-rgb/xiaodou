import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HISTORICAL_MIGRATION_CHECKSUMS,
  sha256Bytes,
  verifyHistoricalMigrationFiles,
} from '../app/db/historical-checksums.js'
import { executeHistoricalMigration } from '../app/db/historical-migration.js'
import { migrateDatabase } from '../app/db/migration-runner.js'

const migrationDirectory = join(process.cwd(), 'app/db/migrations')
const directories: string[] = []
const fingerprint = 'a'.repeat(64)
const otherFingerprint = 'b'.repeat(64)

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('note body migration', () => {
  it('applies 007 on the first empty-database start and records its file checksum', () => {
    const databasePath = tempDatabasePath()
    migrateDatabase(databasePath)
    const database = new Database(databasePath, { readonly: true })
    try {
      const versions = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: string }>
      const row = database.prepare(`SELECT filename, checksum FROM schema_migrations WHERE version = '007'`).get() as { filename: string; checksum: string }
      const columns = database.pragma('table_info(notes)') as Array<{ name: string }>
      expect(versions.map((version) => version.version)).toEqual(['001', '002', '003', '004', '005', '006', '007'])
      expect(row).toEqual({
        filename: '007_note_body.sql',
        checksum: sha256Bytes(readFileSync(join(migrationDirectory, '007_note_body.sql'))),
      })
      expect(columns.map((column) => column.name)).toEqual([
        'id', 'status', 'created_at', 'updated_at', 'title', 'tags_json', 'body_html', 'body_text', 'create_request_id', 'create_request_hash',
      ])
    } finally {
      database.close()
    }
    expect(() => verifyHistoricalMigrationFiles(migrationDirectory)).not.toThrow()
    expect(HISTORICAL_MIGRATION_CHECKSUMS.map((entry) => entry.version)).toEqual(['001', '002', '003', '004', '005', '006'])
  })

  it('upgrades a ready 006 database without changing an existing note identity', () => {
    const databasePath = tempDatabasePath()
    migrateDatabase(databasePath, { migrationsDirectory: copyMigrations(['001', '002', '003', '004', '005', '006']) })
    const setup = new Database(databasePath)
    setup.prepare(`INSERT INTO notes (id, status) VALUES ('old_note', 'CREATED')`).run()
    setup.close()

    migrateDatabase(databasePath)
    const database = new Database(databasePath, { readonly: true })
    try {
      expect(database.prepare(`SELECT id, status, title, tags_json, body_html, body_text, create_request_id, create_request_hash FROM notes WHERE id = 'old_note'`).get()).toEqual({
        id: 'old_note',
        status: 'CREATED',
        title: '',
        tags_json: '[]',
        body_html: '',
        body_text: '',
        create_request_id: null,
        create_request_hash: null,
      })
      expect(database.prepare(`SELECT version FROM schema_migrations WHERE version = '007'`).get()).toEqual({ version: '007' })
    } finally {
      database.close()
    }
  })

  it('adopts a historical database and applies 007 in the same start', () => {
    const databasePath = tempDatabasePath()
    const setup = new Database(databasePath)
    applyHistoricalFiles(setup)
    setup.prepare(`INSERT INTO notes (id) VALUES ('old_note')`).run()
    setup.close()

    migrateDatabase(databasePath)
    const database = new Database(databasePath, { readonly: true })
    try {
      const versions = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: string }>
      expect(database.prepare(`SELECT phase FROM schema_migration_state`).get()).toEqual({ phase: 'ready' })
      expect(database.prepare(`SELECT id, title, tags_json, body_html, body_text FROM notes WHERE id = 'old_note'`).get()).toEqual({
        id: 'old_note',
        title: '',
        tags_json: '[]',
        body_html: '',
        body_text: '',
      })
      expect(versions.map((version) => version.version)).toEqual(['001', '002', '003', '004', '005', '006', '007'])
    } finally {
      database.close()
    }
  })

  it('stores tags, empty body, and a stable create-request fingerprint', () => {
    const database = openMigratedDatabase()
    try {
      database.prepare(`
        INSERT INTO notes (id, title, tags_json, body_html, body_text, create_request_id, create_request_hash)
        VALUES ('n1', '标题', '["TODO","IDEA"]', '<p>正文</p>', '正文', 'req-1', ?)
      `).run(fingerprint)
      database.prepare(`INSERT INTO notes (id, title) VALUES ('n_empty', '空正文')`).run()
      expect(database.prepare(`SELECT tags_json, body_html, body_text, create_request_id, create_request_hash FROM notes WHERE id = 'n_empty'`).get()).toEqual({
        tags_json: '[]',
        body_html: '',
        body_text: '',
        create_request_id: null,
        create_request_hash: null,
      })

      database.prepare(`UPDATE notes SET title = '修改后的标题', body_html = '<p>新</p>', body_text = '新' WHERE id = 'n1'`).run()
      expect(database.prepare(`SELECT title, create_request_id, create_request_hash FROM notes WHERE id = 'n1'`).get()).toEqual({
        title: '修改后的标题',
        create_request_id: 'req-1',
        create_request_hash: fingerprint,
      })

      expect(() => database.prepare(`INSERT INTO notes (id, title) VALUES ('blank', '   ')`).run()).toThrow(/note title is required/)
      expect(() => database.prepare(`INSERT INTO notes (id) VALUES ('bare')`).run()).toThrow(/note title is required/)
      expect(() => database.prepare(`INSERT INTO notes (id, title, tags_json) VALUES ('bad_tag', '标题', '["OTHER"]')`).run()).toThrow(/invalid note tags/)
      expect(() => database.prepare(`INSERT INTO notes (id, title, tags_json) VALUES ('dup_tag', '标题', '["TODO","TODO"]')`).run()).toThrow(/invalid note tags/)
      expect(() => database.prepare(`INSERT INTO notes (id, title, tags_json) VALUES ('obj_tag', '标题', '{"TODO":true}')`).run()).toThrow(/invalid note tags|CHECK constraint failed/)
      expect(() => database.prepare(`
        INSERT INTO notes (id, title, create_request_id, create_request_hash)
        VALUES ('dup_req', '另一篇', 'req-1', ?)
      `).run(otherFingerprint)).toThrow(/UNIQUE constraint failed: notes\.create_request_id/)
      expect(() => database.prepare(`INSERT INTO notes (id, title, create_request_id) VALUES ('id_only', '标题', 'req-2')`).run()).toThrow(/must be stored together/)
      expect(() => database.prepare(`INSERT INTO notes (id, title, create_request_hash) VALUES ('hash_only', '标题', ?)`).run(fingerprint)).toThrow(/must be stored together/)
      expect(() => database.prepare(`
        INSERT INTO notes (id, title, create_request_id, create_request_hash)
        VALUES ('upper', '标题', 'req-3', ?)
      `).run(fingerprint.toUpperCase())).toThrow(/CHECK constraint failed/)
      expect(() => database.prepare(`
        INSERT INTO notes (id, title, create_request_id, create_request_hash)
        VALUES ('short', '标题', 'req-4', 'abcd')
      `).run()).toThrow(/CHECK constraint failed/)
      database.prepare(`INSERT INTO notes (id, title) VALUES ('n_null_a', '无幂等一')`).run()
      database.prepare(`INSERT INTO notes (id, title) VALUES ('n_null_b', '无幂等二')`).run()
      expect(database.prepare(`SELECT COUNT(*) AS count FROM notes WHERE create_request_id IS NULL`).get()).toEqual({ count: 3 })
    } finally {
      database.close()
    }
  })

  it('requires an existing note for NOTE knowledge items without changing PDF or recording sources', () => {
    const database = openMigratedDatabase()
    try {
      database.prepare(`INSERT INTO notes (id, title) VALUES ('note_1', '标题')`).run()
      database.prepare(`
        INSERT INTO files (id, file_name, file_type, file_size, storage_path)
        VALUES ('file_1', 'a.pdf', 'application/pdf', 1, 'uploads/a.pdf')
      `).run()
      expect(() => database.prepare(`
        INSERT INTO knowledge_items (id, source_type, source_id, title)
        VALUES ('missing', 'NOTE', 'missing', '随笔')
      `).run()).toThrow(/NOTE source note not found/)
      database.prepare(`
        INSERT INTO knowledge_items (id, source_type, source_id, title)
        VALUES ('ki_note', 'NOTE', 'note_1', '标题')
      `).run()
      expect(() => database.prepare(`
        INSERT INTO knowledge_items (id, source_type, source_id, title)
        VALUES ('ki_note_2', 'NOTE', 'note_1', '标题')
      `).run()).toThrow(/UNIQUE constraint failed/)
      expect(() => database.prepare(`UPDATE knowledge_items SET source_id = 'missing' WHERE id = 'ki_note'`).run()).toThrow(/NOTE source note not found/)
      database.prepare(`
        INSERT INTO knowledge_items (id, source_type, source_id, title)
        VALUES ('ki_pdf', 'PDF', 'file_1', 'a.pdf')
      `).run()
      expect(() => database.prepare(`
        INSERT INTO knowledge_items (id, source_type, source_id, title)
        VALUES ('ki_pdf_missing', 'PDF', 'missing-file', 'a.pdf')
      `).run()).toThrow(/PDF source file not found/)
      database.prepare(`
        INSERT INTO knowledge_items (id, source_type, source_id, title)
        VALUES ('ki_recording', 'RECORDING', 'recording_1', '录音')
      `).run()
    } finally {
      database.close()
    }
  })

  it('rolls back a failed 007 together with its version row', () => {
    const databasePath = tempDatabasePath()
    const directory = copyMigrations(['001', '002', '003', '004', '005', '006', '007'])
    const target = join(directory, '007_note_body.sql')
    writeFileSync(target, `${readFileSync(target, 'utf8')}\r\nINSERT INTO missing_note_migration (id) VALUES (1);\r\n`)

    expect(() => migrateDatabase(databasePath, { migrationsDirectory: directory })).toThrow(/007_note_body.sql/)
    const database = new Database(databasePath, { readonly: true })
    try {
      const columns = database.pragma('table_info(notes)') as Array<{ name: string }>
      expect(columns.map((column) => column.name)).not.toContain('title')
      expect(database.prepare(`SELECT version FROM schema_migrations WHERE version = '007'`).get()).toBeUndefined()
      expect(database.prepare(`SELECT phase FROM schema_migration_state`).get()).toEqual({ phase: 'ready' })
      expect(database.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all()).toEqual([
        { version: '001' }, { version: '002' }, { version: '003' }, { version: '004' }, { version: '005' }, { version: '006' },
      ])
    } finally {
      database.close()
    }
  })
})

function tempDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'xiaodou-note-body-'))
  directories.push(directory)
  return join(directory, 'notes.db')
}

function openMigratedDatabase(): Database.Database {
  const databasePath = tempDatabasePath()
  migrateDatabase(databasePath)
  return new Database(databasePath)
}

function copyMigrations(versions: readonly string[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'xiaodou-note-migrations-'))
  directories.push(directory)
  for (const filename of readdirSync(migrationDirectory)) {
    if (!versions.some((version) => filename.startsWith(`${version}_`))) continue
    writeFileSync(join(directory, filename), readFileSync(join(migrationDirectory, filename)))
  }
  return directory
}

function applyHistoricalFiles(database: Database.Database): void {
  for (const entry of HISTORICAL_MIGRATION_CHECKSUMS) {
    executeHistoricalMigration(database, entry.filename, readFileSync(join(migrationDirectory, entry.filename), 'utf8'))
  }
}
