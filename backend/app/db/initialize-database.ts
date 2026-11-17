import { config } from '../core/config.js'
import { createDatabaseConnection } from './connection.js'
import { migrateDatabase } from './migration-runner.js'

export function initializeDatabase(databasePath = config.databasePath): void {
  migrateDatabase(databasePath)
  createDatabaseConnection(databasePath)
}
