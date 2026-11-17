import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { closeDatabaseConnection } from '../app/db/connection.js'
import { HISTORICAL_MIGRATION_CHECKSUMS } from '../app/db/historical-checksums.js'
import { applyAdditiveColumns, executeHistoricalMigration } from '../app/db/historical-migration.js'
import { initializeDatabase } from '../app/db/initialize-database.js'
import { migrateDatabase } from '../app/db/migration-runner.js'

const migrationDirectory = join(process.cwd(), 'app/db/migrations')
const directories: string[] = []

afterEach(() => {
  closeDatabaseConnection()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('database migration states', () => {
  it('initializes an empty database through 007 on the first start and does not repeat', () => {
    const databasePath = tempDatabasePath()
    migrateDatabase(databasePath)
    const first = readState(databasePath)
    migrateDatabase(databasePath)
    const second = readState(databasePath)

    expect(first.phase).toBe('ready')
    expect(first.versions.map((row) => row.version)).toEqual(['001', '002', '003', '004', '005', '006', '007'])
    expect(second.executedAt).toEqual(first.executedAt)
    expect(second.counts).toEqual(first.counts)
    expect(tableNames(databasePath)).toEqual(expect.arrayContaining([
      'files', 'recordings', 'schema_migrations', 'schema_migration_state', 'schema_migration_lock',
    ]))
  })

  it('adopts a baseline database without rebuilding business tables or changing row counts', () => {
    const databasePath = tempDatabasePath()
    const setup = new Database(databasePath)
    applyHistoricalFiles(setup, 6)
    setup.exec('CREATE INDEX ix_recordings_canary ON recordings(id)')
    setup.prepare(`INSERT INTO files (id, file_name, file_type, file_size, storage_path) VALUES (?, ?, ?, ?, ?)`).run(
      'file_001', 'file_001.pdf', 'application/pdf', 10, 'uploads/file_001.pdf',
    )
    setup.close()

    migrateDatabase(databasePath)
    const database = new Database(databasePath, { readonly: true })
    const index = database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'index' AND name = 'ix_recordings_canary'`).get()
    const files = database.prepare('SELECT COUNT(*) AS count FROM files').get() as { count: number }
    const phase = database.prepare('SELECT phase FROM schema_migration_state').get() as { phase: string }
    database.close()

    expect(index).toEqual({ found: 1 })
    expect(files.count).toBe(1)
    expect(phase.phase).toBe('ready')
  })

  it('refuses an abnormal database and leaves its business rows untouched', () => {
    const databasePath = tempDatabasePath()
    const setup = new Database(databasePath)
    setup.exec('CREATE TABLE files (id TEXT PRIMARY KEY, file_name TEXT)')
    setup.prepare('INSERT INTO files (id, file_name) VALUES (?, ?)').run('file_001', 'kept.pdf')
    setup.close()

    expect(() => migrateDatabase(databasePath)).toThrow(/does not match the 006 baseline/)
    const database = new Database(databasePath, { readonly: true })
    const count = database.prepare('SELECT COUNT(*) AS count FROM files').get() as { count: number }
    const versions = database.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations'`).get()
    database.close()
    expect(count.count).toBe(1)
    expect(versions).toBeUndefined()
  })

  it('refuses a changed historical checksum before any business migration runs', () => {
    const databasePath = tempDatabasePath()
    const directory = copyMigrations((filename, bytes) => filename.startsWith('004')
      ? Buffer.concat([bytes, Buffer.from(' ')])
      : bytes)

    expect(() => migrateDatabase(databasePath, { migrationsDirectory: directory })).toThrow(/004_task_source_association.sql checksum/)
    const database = new Database(databasePath, { readonly: true })
    const files = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'files'`).get()
    database.close()
    expect(files).toBeUndefined()
  })

  it('records a completed historical migration without executing its rebuild again', () => {
    const databasePath = tempDatabasePath()
    const setup = new Database(databasePath)
    applyHistoricalFiles(setup, 6)
    setup.exec('CREATE INDEX ix_recordings_canary ON recordings(id)')
    setup.prepare(`INSERT INTO recordings (id, title) VALUES (?, ?)`).run('rec_001', '保留录音')
    installMigrationState(setup, ['001', '002', '003', '004', '005'])
    setup.close()

    migrateDatabase(databasePath)
    const database = new Database(databasePath, { readonly: true })
    const index = database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE name = 'ix_recordings_canary'`).get()
    const recording = database.prepare(`SELECT title FROM recordings WHERE id = 'rec_001'`).get() as { title: string }
    const versions = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: string }>
    database.close()

    expect(index).toEqual({ found: 1 })
    expect(recording.title).toBe('保留录音')
    expect(versions.map((row) => row.version)).toContain('006')
  })

  it('continues 005 after its additive columns were committed and the rebuild had not run', () => {
    const databasePath = tempDatabasePath()
    const setup = new Database(databasePath)
    applyHistoricalFiles(setup, 4)
    setup.prepare('INSERT INTO recordings (id) VALUES (?)').run('rec_001')
    const sql = readFileSync(join(migrationDirectory, '005_recording_pipeline.sql'), 'utf8')
    applyAdditiveColumns(setup, sql)
    installMigrationState(setup, ['001', '002', '003', '004'])
    setup.close()

    migrateDatabase(databasePath)
    const database = new Database(databasePath)
    const recording = database.prepare(`SELECT title, status FROM recordings WHERE id = 'rec_001'`).get() as { title: string; status: string }
    const columns = database.pragma('table_info(recordings)') as Array<{ name: string }>
    database.close()

    expect(recording).toEqual({ title: '录音', status: 'CREATED' })
    expect(columns.map((column) => column.name)).toContain('title')
  })

  it('keeps recording_id when 003 is entered again after that column exists', () => {
    const databasePath = tempDatabasePath()
    migrateDatabase(databasePath)
    const database = new Database(databasePath)
    database.prepare(`INSERT INTO files (id, file_name, file_type, file_size, storage_path) VALUES (?, ?, ?, ?, ?)`).run(
      'file_001', 'file_001.pdf', 'application/pdf', 10, 'uploads/file_001.pdf',
    )
    database.prepare('INSERT INTO tasks (id, file_id, request_id) VALUES (?, ?, ?)').run('task_001', 'file_001', 'request_001')
    const outcome = executeHistoricalMigration(
      database,
      '003_task_type_extension.sql',
      readFileSync(join(migrationDirectory, '003_task_type_extension.sql'), 'utf8'),
    )
    const task = database.prepare('SELECT id, recording_id FROM tasks WHERE id = ?').get('task_001') as { id: string; recording_id: string | null }
    const columns = database.pragma('table_info(tasks)') as Array<{ name: string }>
    database.close()

    expect(outcome).toBe('skipped')
    expect(task).toEqual({ id: 'task_001', recording_id: null })
    expect(columns.map((column) => column.name)).toContain('recording_id')
  })

  it('rejects transaction control in an incremental file', () => {
    const databasePath = tempDatabasePath()
    const historical = copyMigrations()
    migrateDatabase(databasePath, { migrationsDirectory: historical })
    writeFileSync(join(historical, '007_probe.sql'), 'BEGIN IMMEDIATE;\nCREATE TABLE migration_probe (id INTEGER PRIMARY KEY);')
    expect(() => migrateDatabase(databasePath, { migrationsDirectory: historical })).toThrow(/must not control transactions/)
    expect(readState(databasePath).versions.map((row) => row.version)).not.toContain('007')
    expect(tableNames(databasePath)).not.toContain('migration_probe')
  })

  it('rolls back a failed incremental migration and a failed version insert together', () => {
    const databasePath = tempDatabasePath()
    const historical = copyMigrations()
    migrateDatabase(databasePath, { migrationsDirectory: historical })
    const withFailure = historical
    writeFileSync(join(withFailure, '007_probe.sql'), `
      CREATE TABLE migration_probe (id INTEGER PRIMARY KEY);
      INSERT INTO migration_probe (id) VALUES (1);
      INSERT INTO missing_migration_probe (id) VALUES (1);
    `)
    expect(() => migrateDatabase(databasePath, { migrationsDirectory: withFailure })).toThrow(/007_probe.sql/)
    expect(readState(databasePath).versions.map((row) => row.version)).not.toContain('007')
    expect(tableNames(databasePath)).not.toContain('migration_probe')

    const withBlockedInsert = copyMigrations()
    writeFileSync(join(withBlockedInsert, '007_probe.sql'), 'CREATE TABLE migration_probe (id INTEGER PRIMARY KEY);')
    const setup = new Database(databasePath)
    setup.exec(`
      CREATE TRIGGER block_schema_migration_insert
      BEFORE INSERT ON schema_migrations
      BEGIN
        SELECT RAISE(ABORT, 'block version');
      END
    `)
    setup.close()
    expect(() => migrateDatabase(databasePath, { migrationsDirectory: withBlockedInsert })).toThrow(/007_probe.sql/)
    expect(tableNames(databasePath)).not.toContain('migration_probe')
    expect(readState(databasePath).phase).toBe('ready')
  })

  it('rejects a gap, an unknown version, a missing file, and a checksum mismatch', () => {
    expect(() => {
      const databasePath = tempDatabasePath()
      migrateDatabase(databasePath)
      const database = new Database(databasePath)
      database.prepare(`DELETE FROM schema_migrations WHERE version = '003'`).run()
      database.close()
      migrateDatabase(databasePath)
    }).toThrow(/diverges/)

    expect(() => {
      const databasePath = tempDatabasePath()
      migrateDatabase(databasePath)
      const database = new Database(databasePath)
      database.prepare(`INSERT INTO schema_migrations (version, filename, checksum, executed_at) VALUES ('999', '999_unknown.sql', ?, '2026-01-01T00:00:00.000Z')`).run('a'.repeat(64))
      database.close()
      migrateDatabase(databasePath)
    }).toThrow(/999/)

    expect(() => {
      const databasePath = tempDatabasePath()
      migrateDatabase(databasePath)
      const missing = copyMigrations((_filename, bytes) => bytes, ['001', '003', '004', '005', '006'])
      migrateDatabase(databasePath, { migrationsDirectory: missing })
    }).toThrow(/is missing/)

    expect(() => {
      const databasePath = tempDatabasePath()
      migrateDatabase(databasePath)
      const database = new Database(databasePath)
      database.prepare(`UPDATE schema_migrations SET checksum = ? WHERE version = '001'`).run('b'.repeat(64))
      database.close()
      migrateDatabase(databasePath)
    }).toThrow(/checksum/)
  })
})

describe('database initialization', () => {
  it('migrates the explicit database path before opening the application connection', () => {
    const databasePath = tempDatabasePath()
    initializeDatabase(databasePath)
    const state = readState(databasePath)
    expect(state.phase).toBe('ready')
    expect(state.versions).toHaveLength(7)
  })
})

function tempDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'xiaodou-migrate-'))
  directories.push(directory)
  return join(directory, 'migrate.db')
}

function copyMigrations(
  mutate: (filename: string, bytes: Buffer) => Buffer = (_filename, bytes) => bytes,
  versions = ['001', '002', '003', '004', '005', '006'],
): string {
  const directory = mkdtempSync(join(tmpdir(), 'xiaodou-migrations-'))
  directories.push(directory)
  for (const filename of readdirSync(migrationDirectory)) {
    if (!versions.some((version) => filename.startsWith(`${version}_`))) continue
    const bytes = readFileSync(join(migrationDirectory, filename))
    writeFileSync(join(directory, filename), mutate(filename, bytes))
  }
  return directory
}

function applyHistoricalFiles(database: Database.Database, throughVersion: number): void {
  for (const entry of HISTORICAL_MIGRATION_CHECKSUMS) {
    if (Number(entry.version) > throughVersion) break
    executeHistoricalMigration(database, entry.filename, readFileSync(join(migrationDirectory, entry.filename), 'utf8'))
  }
}

function installMigrationState(database: Database.Database, versions: string[]): void {
  database.exec(`
    CREATE TABLE schema_migrations (
      version TEXT NOT NULL PRIMARY KEY,
      filename TEXT NOT NULL,
      checksum TEXT NOT NULL,
      executed_at TEXT NOT NULL
    );
    CREATE TABLE schema_migration_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      phase TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  const insert = database.prepare(`
    INSERT INTO schema_migrations (version, filename, checksum, executed_at)
    VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')
  `)
  for (const version of versions) {
    const entry = HISTORICAL_MIGRATION_CHECKSUMS.find((item) => item.version === version)
    if (!entry) throw new Error(`Missing checksum ${version}`)
    insert.run(entry.version, entry.filename, entry.checksum)
  }
  database.prepare(`
    INSERT INTO schema_migration_state (id, phase, updated_at)
    VALUES (1, 'bootstrap', '2026-01-01T00:00:00.000Z')
  `).run()
}

function readState(databasePath: string): {
  phase: string
  versions: Array<{ version: string }>
  executedAt: string[]
  counts: Record<string, number>
} {
  const database = new Database(databasePath, { readonly: true })
  const phase = database.prepare('SELECT phase FROM schema_migration_state').get() as { phase: string }
  const versions = database.prepare('SELECT version, executed_at FROM schema_migrations ORDER BY version').all() as Array<{ version: string; executed_at: string }>
  const counts: Record<string, number> = {}
  for (const table of ['files', 'recordings', 'tasks', 'summaries']) {
    counts[table] = (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
  }
  database.close()
  return {
    phase: phase.phase,
    versions,
    executedAt: versions.map((row) => row.executed_at),
    counts,
  }
}

function tableNames(databasePath: string): string[] {
  const database = new Database(databasePath, { readonly: true })
  const names = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>
  database.close()
  return names.map((row) => row.name)
}
