import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type Database from 'better-sqlite3'
import { getDatabaseConnection } from './connection.js'
import {
  HISTORICAL_MIGRATION_CHECKSUMS,
  sha256Bytes,
  verifyHistoricalMigrationFiles,
  type HistoricalMigrationChecksum,
} from './historical-checksums.js'
import { executeHistoricalMigration, historicalAction } from './historical-migration.js'
import { acquireMigrationLock } from './migration-lock.js'
import { compareToBaseline, isTemporaryMigrationTable, listBusinessTables } from './schema-baseline.js'
import { tokenizeSql } from './sql-normalizer.js'

const defaultMigrationDirectory = resolve(process.cwd(), 'app/db/migrations')

export interface MigrateOptions {
  migrationsDirectory?: string
  lockTimeoutMs?: number
}

export interface AppliedMigration {
  version: string
  filename: string
  checksum: string
  executed_at: string
}

export class MigrationStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MigrationStateError'
  }
}

export function runMigration(database: Database.Database = getDatabaseConnection()): void {
  if (!database.name || database.name === ':memory:') {
    throw new MigrationStateError('Migration requires a file-backed SQLite database')
  }
  migrateDatabase(database.name)
}

export function migrateDatabase(databasePath: string, options: MigrateOptions = {}): void {
  const migrationsDirectory = options.migrationsDirectory ?? defaultMigrationDirectory
  const lock = acquireMigrationLock(databasePath, options.lockTimeoutMs)
  try {
    lock.database.pragma('foreign_keys = ON')
    verifyHistoricalMigrationFiles(migrationsDirectory)
    const files = listMigrationFiles(migrationsDirectory)
    const recorded = readAppliedMigrations(lock.database)
    const phase = readPhase(lock.database)
    if ((recorded === null) !== (phase === null)) {
      throw new MigrationStateError('schema_migrations and schema_migration_state must be created together')
    }

    if (phase === null) {
      if (listBusinessTables(lock.database).length === 0) {
        beginBootstrap(lock.database)
        finishHistoricalMigrations(lock.database, files)
      } else {
        adoptHistoricalDatabase(lock.database)
      }
      applyIncrementalAfterReady(lock.database, files)
    } else if (phase === 'bootstrap') {
      assertBootstrapRecords(recorded ?? [])
      finishHistoricalMigrations(lock.database, files)
      applyIncrementalAfterReady(lock.database, files)
    } else if (phase === 'ready') {
      applyIncrementalAfterReady(lock.database, files)
    } else {
      throw new MigrationStateError(`Unrecognized migration phase: ${phase}`)
    }
    lock.database.pragma('foreign_keys = ON')
  } finally {
    lock.release()
  }
}

function finishHistoricalMigrations(database: Database.Database, files: MigrationFile[]): void {
  const recorded = new Set(readAppliedMigrations(database)?.map((row) => row.version) ?? [])
  for (const entry of HISTORICAL_MIGRATION_CHECKSUMS) {
    if (recorded.has(entry.version)) {
      if (historicalAction(database, entry.version) !== 'record-only') {
        throw new MigrationStateError(`Historical version ${entry.version} is recorded, but the database structure does not match it`)
      }
      continue
    }
    const action = historicalAction(database, entry.version)
    if (action === 'refuse') {
      throw new MigrationStateError(`Database structure is not a safe ${entry.version} continuation. Refusing to execute historical SQL.`)
    }
    if (action === 'execute') {
      const file = files.find((item) => item.version === entry.version)
      if (!file) throw new MigrationStateError(`Historical migration file ${entry.filename} is missing`)
      try {
        executeHistoricalMigration(database, entry.filename, readFileSync(file.path, 'utf8'))
      } catch (error: unknown) {
        throw new Error(`Failed to run migration ${entry.filename}: ${String(error)}`, { cause: error })
      }
    }
    recordMigration(database, entry, entry.checksum)
    recorded.add(entry.version)
  }

  const violations = compareToBaseline(database)
  if (violations.length > 0) {
    throw new MigrationStateError(`Historical migrations did not reach the 006 baseline: ${violations.join('; ')}`)
  }
  database.prepare(`
    UPDATE schema_migration_state
    SET phase = 'ready', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = 1
  `).run()
}

function adoptHistoricalDatabase(database: Database.Database): void {
  const violations = compareToBaseline(database)
  if (violations.length > 0) {
    throw new MigrationStateError(`Refusing to adopt a database that does not match the 006 baseline: ${violations.join('; ')}`)
  }
  database.exec('BEGIN IMMEDIATE')
  try {
    createMigrationTables(database)
    for (const entry of HISTORICAL_MIGRATION_CHECKSUMS) {
      recordMigration(database, entry, entry.checksum)
    }
    database.prepare(`
      INSERT INTO schema_migration_state (id, phase, updated_at)
      VALUES (1, 'ready', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run()
    database.exec('COMMIT')
  } catch (error: unknown) {
    if (database.inTransaction) database.exec('ROLLBACK')
    throw error
  }
}

function applyIncrementalAfterReady(database: Database.Database, files: MigrationFile[]): void {
  const recorded = readAppliedMigrations(database) ?? []
  assertReadyRecords(recorded, files)
  applyIncrementalMigrations(database, files, new Set(recorded.map((row) => row.version)))
}

function applyIncrementalMigrations(
  database: Database.Database,
  files: MigrationFile[],
  recorded: Set<string>,
): void {
  if (listTemporaryTables(database).length > 0) {
    throw new MigrationStateError(`Refusing to migrate while temporary tables remain: ${listTemporaryTables(database).join(', ')}`)
  }
  for (const file of files) {
    if (recorded.has(file.version)) continue
    if (HISTORICAL_MIGRATION_CHECKSUMS.some((entry) => entry.version === file.version)) {
      throw new MigrationStateError(`Ready database is missing historical version ${file.version}`)
    }
    const sql = readFileSync(file.path, 'utf8')
    assertIncrementalSql(file.filename, sql)
    const checksum = sha256Bytes(readFileSync(file.path))
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(sql)
      recordMigration(database, { version: file.version, filename: file.filename, checksum }, checksum)
      database.exec('COMMIT')
      recorded.add(file.version)
    } catch (error: unknown) {
      if (database.inTransaction) database.exec('ROLLBACK')
      throw new Error(`Failed to run migration ${file.filename}: ${String(error)}`, { cause: error })
    }
  }
}

function beginBootstrap(database: Database.Database): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    createMigrationTables(database)
    database.prepare(`
      INSERT INTO schema_migration_state (id, phase, updated_at)
      VALUES (1, 'bootstrap', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run()
    database.exec('COMMIT')
  } catch (error: unknown) {
    if (database.inTransaction) database.exec('ROLLBACK')
    throw error
  }
}

function createMigrationTables(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT NOT NULL PRIMARY KEY,
      filename TEXT NOT NULL,
      checksum TEXT NOT NULL CHECK (length(checksum) = 64),
      executed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schema_migration_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      phase TEXT NOT NULL CHECK (phase IN ('bootstrap', 'ready')),
      updated_at TEXT NOT NULL
    );
  `)
}

function recordMigration(
  database: Database.Database,
  entry: Pick<HistoricalMigrationChecksum, 'version' | 'filename' | 'checksum'>,
  checksum: string,
): void {
  database.prepare(`
    INSERT INTO schema_migrations (version, filename, checksum, executed_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `).run(entry.version, entry.filename, checksum)
}

function assertBootstrapRecords(recorded: AppliedMigration[]): void {
  const expected = HISTORICAL_MIGRATION_CHECKSUMS.map((entry) => entry.version)
  recorded.forEach((row, index) => {
    if (row.version !== expected[index]) {
      throw new MigrationStateError(`Bootstrap history has a gap or unknown version at ${row.version}`)
    }
    const entry = HISTORICAL_MIGRATION_CHECKSUMS[index]
    if (!entry || row.filename !== entry.filename || row.checksum !== entry.checksum) {
      throw new MigrationStateError(`Historical checksum mismatch for recorded version ${row.version}`)
    }
  })
}

function assertReadyRecords(recorded: AppliedMigration[], files: MigrationFile[]): void {
  const fileByVersion = new Map(files.map((file) => [file.version, file]))
  const historical = new Map(HISTORICAL_MIGRATION_CHECKSUMS.map((entry) => [entry.version, entry]))
  const versions = recorded.map((row) => row.version)
  const fileVersions = files.map((file) => file.version)
  versions.forEach((version, index) => {
    if (version !== fileVersions[index]) {
      throw new MigrationStateError(`Migration history diverges at ${version}; expected ${fileVersions[index] ?? 'no further file'}`)
    }
  })
  for (const row of recorded) {
    const file = fileByVersion.get(row.version)
    if (!file || file.filename !== row.filename) {
      throw new MigrationStateError(`Migration file for recorded version ${row.version} is missing`)
    }
    const trusted = historical.get(row.version)
    const fileChecksum = sha256Bytes(readFileSync(file.path))
    if (trusted) {
      if (row.checksum !== trusted.checksum || fileChecksum !== trusted.checksum) {
        throw new MigrationStateError(`Historical checksum mismatch for ${row.filename}`)
      }
    } else if (row.checksum !== fileChecksum) {
      throw new MigrationStateError(`Checksum mismatch for applied migration ${row.filename}`)
    }
  }
  for (const entry of HISTORICAL_MIGRATION_CHECKSUMS) {
    if (!versions.includes(entry.version)) {
      throw new MigrationStateError(`Ready database is missing historical version ${entry.version}`)
    }
  }
}

function assertIncrementalSql(filename: string, sql: string): void {
  const tokens = tokenizeSql(sql).map((token) => token.toUpperCase())
  const nested: Array<'trigger' | 'case'> = []
  let expectingTriggerBody = false
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === 'CREATE' && tokens[index + 1] === 'TRIGGER') {
      expectingTriggerBody = true
    } else if (token === 'BEGIN') {
      if (!expectingTriggerBody) {
        throw new MigrationStateError(`${filename} must not control transactions; the runner commits it with the version row`)
      }
      expectingTriggerBody = false
      nested.push('trigger')
    } else if (token === 'CASE') {
      nested.push('case')
    } else if (token === 'END') {
      nested.pop()
    } else if (token === 'COMMIT' || token === 'ROLLBACK') {
      throw new MigrationStateError(`${filename} must not control transactions; the runner commits it with the version row`)
    } else if (token === 'PRAGMA' && tokens[index + 1] === 'FOREIGN_KEYS') {
      throw new MigrationStateError(`${filename} must not change PRAGMA foreign_keys`)
    }
  }
  if (expectingTriggerBody || nested.includes('trigger')) {
    throw new MigrationStateError(`${filename} has an unclosed trigger`)
  }
}

interface MigrationFile {
  version: string
  filename: string
  path: string
}

function listMigrationFiles(migrationsDirectory: string): MigrationFile[] {
  const files = readdirSync(migrationsDirectory)
    .filter((name) => /^\d{3}_.+\.sql$/u.test(name))
    .sort()
    .map((filename) => ({
      version: filename.slice(0, 3),
      filename,
      path: resolve(migrationsDirectory, filename),
    }))
  for (let index = 1; index < files.length; index += 1) {
    const previous = files[index - 1]
    const current = files[index]
    if (!previous || !current || Number(current.version) !== Number(previous.version) + 1) {
      throw new MigrationStateError(`Migration version gap before ${current?.version ?? 'end'}`)
    }
  }
  const versions = new Set<string>()
  for (const file of files) {
    if (versions.has(file.version)) {
      throw new MigrationStateError(`Duplicate migration version ${file.version}`)
    }
    versions.add(file.version)
  }
  return files
}

function readAppliedMigrations(database: Database.Database): AppliedMigration[] | null {
  if (!tableExists(database, 'schema_migrations')) return null
  return database.prepare(`
    SELECT version, filename, checksum, executed_at
    FROM schema_migrations
    ORDER BY version
  `).all() as AppliedMigration[]
}

function readPhase(database: Database.Database): string | null {
  if (!tableExists(database, 'schema_migration_state')) return null
  const row = database.prepare('SELECT phase FROM schema_migration_state WHERE id = 1').get() as { phase: string } | undefined
  return row?.phase ?? null
}

function tableExists(database: Database.Database, name: string): boolean {
  return Boolean(database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name))
}

function listTemporaryTables(database: Database.Database): string[] {
  return listBusinessTables(database).filter((name) => isTemporaryMigrationTable(name))
}
