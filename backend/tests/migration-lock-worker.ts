import { existsSync, writeFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { acquireMigrationLock } from '../app/db/migration-lock.js'

const [command, databasePath, readyPath = '', signalPath = '', timeoutArg = '10000'] = process.argv.slice(2)

if (command === 'hold') {
  const lock = acquireMigrationLock(databasePath)
  writeFileSync(readyPath, 'ready')
  const deadline = Date.now() + 30_000
  while (!existsSync(signalPath) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40)
  }
  lock.release()
  process.exit(0)
}

if (command === 'die') {
  acquireMigrationLock(databasePath)
  writeFileSync(readyPath, 'ready')
  process.exit(1)
}

if (command === 'acquire') {
  writeFileSync(readyPath, 'attempting')
  const started = Date.now()
  try {
    const lock = acquireMigrationLock(databasePath, Number(timeoutArg))
    const row = lock.database.prepare('SELECT id, acquired_at FROM schema_migration_lock WHERE id = 1').get()
    writeFileSync(signalPath, JSON.stringify({ ok: true, elapsedMs: Date.now() - started, row }))
    lock.release()
  } catch (error: unknown) {
    writeFileSync(signalPath, JSON.stringify({
      ok: false,
      elapsedMs: Date.now() - started,
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    }))
  }
  process.exit(0)
}

if (command === 'read') {
  const database = new Database(databasePath, { timeout: Number(timeoutArg) })
  try {
    const row = database.prepare('SELECT COUNT(*) AS count FROM schema_migration_lock').get()
    writeFileSync(signalPath, JSON.stringify({ ok: true, row }))
  } catch (error: unknown) {
    writeFileSync(signalPath, JSON.stringify({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }))
  } finally {
    database.close()
  }
  process.exit(0)
}

process.exit(2)
