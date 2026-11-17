import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'

export const MIGRATION_LOCK_TIMEOUT_MS = 10_000

export class MigrationLockError extends Error {
  readonly code: string

  constructor(message: string, code = 'SQLITE_BUSY') {
    super(message)
    this.name = 'MigrationLockError'
    this.code = code
  }
}

export interface MigrationLock {
  readonly database: Database.Database
  release(): void
}

/**
 * Holds a SQLite reserved lock on a dedicated connection until release().
 * The schema_migration_lock row is only a record written while the lock is
 * taken. Closing this connection releases the database lock.
 */
export function acquireMigrationLock(
  databasePath: string,
  timeoutMs = MIGRATION_LOCK_TIMEOUT_MS,
): MigrationLock {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw new MigrationLockError(`Migration lock timeout must be a non-negative integer, received ${timeoutMs}`, 'INVALID_TIMEOUT')
  }

  const resolvedPath = resolve(databasePath)
  mkdirSync(dirname(resolvedPath), { recursive: true })
  const database = new Database(resolvedPath, { timeout: timeoutMs })
  let released = false
  const release = () => {
    if (released) return
    released = true
    if (database.inTransaction) database.exec('ROLLBACK')
    database.close()
  }

  try {
    database.pragma(`busy_timeout = ${timeoutMs}`)
    database.pragma('locking_mode = EXCLUSIVE')
    database.exec('BEGIN IMMEDIATE')
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migration_lock (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        acquired_at TEXT NOT NULL
      )
    `)
    database.prepare(`
      INSERT INTO schema_migration_lock (id, acquired_at)
      VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(id) DO UPDATE SET acquired_at = excluded.acquired_at
    `).run()
    database.exec('COMMIT')
  } catch (error: unknown) {
    release()
    if (isBusy(error)) {
      throw new MigrationLockError(
        `Timed out after ${timeoutMs}ms waiting for the migration lock. Stop the other service process before retrying.`,
        'SQLITE_BUSY',
      )
    }
    throw error
  }

  return { database, release }
}

function isBusy(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'SQLITE_BUSY'
}
