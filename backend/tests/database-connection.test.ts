import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  closeDatabaseConnection,
  createDatabaseConnection,
  getDatabaseConnection,
} from '../app/db/connection.js'

let temporaryDirectory: string | undefined

afterEach(async () => {
  closeDatabaseConnection()

  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true })
    temporaryDirectory = undefined
  }
})

describe('SQLite database connection', () => {
  it('connects, executes SQL, enables foreign keys, and closes cleanly', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'xiaodou-db-'))
    const databasePath = join(temporaryDirectory, 'test.db')
    const database = createDatabaseConnection(databasePath)

    expect(database).toBe(getDatabaseConnection())
    expect(database.prepare('SELECT 1 AS value').get()).toEqual({ value: 1 })
    expect(database.pragma('foreign_keys', { simple: true })).toBe(1)

    closeDatabaseConnection()

    const reopenedDatabase = createDatabaseConnection(databasePath)
    expect(reopenedDatabase.prepare('SELECT 1 AS value').get()).toEqual({ value: 1 })
    expect(reopenedDatabase).toBe(getDatabaseConnection())
  })
})
