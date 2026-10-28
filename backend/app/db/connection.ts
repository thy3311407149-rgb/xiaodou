import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { config } from '../core/config.js'

let connection: Database.Database | null = null

export function createDatabaseConnection(databasePath: string = config.databasePath): Database.Database {
  if (connection) {
    return connection
  }

  const resolvedPath = resolve(databasePath)
  mkdirSync(dirname(resolvedPath), { recursive: true })

  connection = new Database(resolvedPath)
  connection.pragma('foreign_keys = ON')

  return connection
}

export function getDatabaseConnection(): Database.Database {
  return connection ?? createDatabaseConnection()
}

export function closeDatabaseConnection(): void {
  if (!connection) {
    return
  }

  connection.close()
  connection = null
}
