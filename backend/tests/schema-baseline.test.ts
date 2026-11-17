import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  closeDatabaseConnection,
  createDatabaseConnection,
} from '../app/db/connection.js'
import {
  HISTORICAL_MIGRATION_CHECKSUMS,
  verifyHistoricalMigrationFiles,
} from '../app/db/historical-checksums.js'
import { migrateDatabase } from '../app/db/migration-runner.js'
import {
  CORE_BUSINESS_TABLES,
  compareToBaseline,
  loadBaselineSnapshot,
} from '../app/db/schema-baseline.js'
import { normalizeSql } from '../app/db/sql-normalizer.js'

const migrationDirectory = join(process.cwd(), 'app/db/migrations')
let temporaryDirectory: string | undefined

afterEach(async () => {
  closeDatabaseConnection()
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true })
    temporaryDirectory = undefined
  }
})

describe('historical migration checksums', () => {
  it('matches the six historical files byte for byte', () => {
    expect(HISTORICAL_MIGRATION_CHECKSUMS.map((entry) => entry.version)).toEqual([
      '001', '002', '003', '004', '005', '006',
    ])
    expect(() => verifyHistoricalMigrationFiles(migrationDirectory)).not.toThrow()
  })

  it('rejects a one-byte change and a line-ending change', async () => {
    const checksumDirectory = await mkdtemp(join(tmpdir(), 'xiaodou-checksum-'))
    temporaryDirectory = checksumDirectory
    for (const entry of HISTORICAL_MIGRATION_CHECKSUMS) {
      const source = join(migrationDirectory, entry.filename)
      await writeFile(join(checksumDirectory, entry.filename), await readFile(source))
    }

    const target = join(checksumDirectory, '006_recording_pause.sql')
    const original = await readFile(target)
    await writeFile(target, Buffer.concat([original.subarray(0, original.length - 1), Buffer.from([original.at(-1)! ^ 1])]))
    expect(() => verifyHistoricalMigrationFiles(checksumDirectory)).toThrow(/006_recording_pause.sql checksum/)

    await writeFile(target, original.toString('utf8').replace(/\r\n/g, '\n'))
    expect(() => verifyHistoricalMigrationFiles(checksumDirectory)).toThrow(/006_recording_pause.sql checksum/)
  })

  it('rejects a missing historical file', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'xiaodou-checksum-'))
    expect(() => verifyHistoricalMigrationFiles(temporaryDirectory!)).toThrow(/is missing/)
  })
})

describe('SQL normalizer', () => {
  it('collapses whitespace outside literals and preserves spaces inside strings', () => {
    expect(normalizeSql("SELECT  'keep  spaces' \r\n FROM t")).toBe("SELECT 'keep  spaces' FROM t")
    expect(normalizeSql("SELECT 'it''s  fine'")).toBe("SELECT 'it''s  fine'")
    expect(normalizeSql('SELECT 1 -- comment\nFROM t')).toBe('SELECT 1 FROM t')
  })
})

describe('006 schema baseline', () => {
  it('matches a database created from the unmodified historical migrations', async () => {
    const database = await openMigratedDatabase()
    expect(Object.keys(loadBaselineSnapshot().tables).sort()).toEqual([...CORE_BUSINESS_TABLES].sort())
    expect(compareToBaseline(database)).toEqual([])
  })

  it('allows an extra non-unique index and rejects an extra unique index', async () => {
    const database = await openMigratedDatabase()
    database.exec('CREATE INDEX ix_notes_status_extra ON notes(status)')
    expect(compareToBaseline(database)).toEqual([])

    database.exec('CREATE UNIQUE INDEX ux_notes_status_extra ON notes(status)')
    expect(compareToBaseline(database).join('\n')).toContain('extra unique index ux_notes_status_extra')
  })

  it('rejects a temporary migration table', async () => {
    const database = await openMigratedDatabase()
    database.exec('CREATE TABLE recordings_new (id TEXT PRIMARY KEY)')
    expect(compareToBaseline(database).join('\n')).toContain('temporary migration table recordings_new')
  })

  it('rejects a missing core table, a changed column type, and a removed NOT NULL', async () => {
    const database = await openMigratedDatabase()
    database.pragma('foreign_keys = OFF')
    database.exec('DROP TABLE notes')
    expect(compareToBaseline(database).join('\n')).toContain('missing core table notes')

    database.exec(`
      CREATE TABLE notes (
        id TEXT NOT NULL PRIMARY KEY,
        status TEXT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    const notNullViolations = compareToBaseline(database).join('\n')
    expect(notNullViolations).toContain('notes columns differ')

    database.exec('DROP TABLE notes')
    database.exec(`
      CREATE TABLE notes (
        id TEXT NOT NULL PRIMARY KEY,
        status INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    expect(compareToBaseline(database).join('\n')).toContain('notes columns differ')
  })

  it('rejects a removed foreign key and a changed CHECK constraint', async () => {
    const database = await openMigratedDatabase()
    database.pragma('foreign_keys = OFF')
    database.exec('DROP TABLE document_texts')
    database.exec(`
      CREATE TABLE document_texts (
        id TEXT NOT NULL PRIMARY KEY,
        file_id TEXT NOT NULL,
        page_number INTEGER NOT NULL CHECK (page_number >= 1),
        content TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        CONSTRAINT uq_document_texts_file_page UNIQUE (file_id, page_number)
      )
    `)
    expect(compareToBaseline(database).join('\n')).toContain('document_texts foreign keys differ')

    database.exec('DROP TABLE recordings')
    database.exec(`
      CREATE TABLE recordings (
        id TEXT NOT NULL PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '录音',
        status TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'ENDED')),
        mime_type TEXT NULL,
        sample_rate INTEGER NULL,
        started_at TEXT NULL,
        ended_at TEXT NULL,
        interrupted_at TEXT NULL,
        error_code TEXT NULL,
        error_message TEXT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    expect(compareToBaseline(database).join('\n')).toContain('recordings table SQL differs')
  })

  it('rejects a missing trigger', async () => {
    const database = await openMigratedDatabase()
    database.exec('DROP TRIGGER trg_tasks_step_matches_type_insert')
    expect(compareToBaseline(database).join('\n')).toContain('trigger trg_tasks_step_matches_type_insert is missing')
  })
})

async function openMigratedDatabase() {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'xiaodou-baseline-'))
  const migrations = join(temporaryDirectory, 'migrations')
  await mkdir(migrations)
  for (const entry of HISTORICAL_MIGRATION_CHECKSUMS) {
    await copyFile(join(migrationDirectory, entry.filename), join(migrations, entry.filename))
  }
  const databasePath = join(temporaryDirectory, 'baseline.db')
  migrateDatabase(databasePath, { migrationsDirectory: migrations })
  return createDatabaseConnection(databasePath)
}
