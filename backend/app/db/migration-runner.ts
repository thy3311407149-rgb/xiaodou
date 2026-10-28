import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type Database from 'better-sqlite3'
import { getDatabaseConnection } from './connection.js'

const initialSchemaPath = resolve(process.cwd(), 'app/db/migrations/001_initial_schema.sql')

export function runMigration(database: Database.Database = getDatabaseConnection()): void {
  const sql = readFileSync(initialSchemaPath, 'utf8')

  try {
    database.exec(sql)
  } catch (error: unknown) {
    throw new Error(`Failed to run initial schema migration: ${String(error)}`, { cause: error })
  }
}
