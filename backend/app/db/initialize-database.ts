import { getDatabaseConnection } from './connection.js'
import { runMigration } from './migration-runner.js'

export function initializeDatabase(): void {
  const database = getDatabaseConnection()
  runMigration(database)
}
