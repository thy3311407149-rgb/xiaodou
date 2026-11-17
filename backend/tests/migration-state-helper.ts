import type Database from 'better-sqlite3'
import { HISTORICAL_MIGRATION_CHECKSUMS } from '../app/db/historical-checksums.js'

export function markHistoricalBootstrap(database: Database.Database, versions: readonly string[]): void {
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
    if (!entry) throw new Error(`Missing historical checksum for ${version}`)
    insert.run(entry.version, entry.filename, entry.checksum)
  }
  database.prepare(`
    INSERT INTO schema_migration_state (id, phase, updated_at)
    VALUES (1, 'bootstrap', '2026-01-01T00:00:00.000Z')
  `).run()
}
