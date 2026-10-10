import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { closeDatabaseConnection, createDatabaseConnection } from '../app/db/connection.js'
import { runMigration } from '../app/db/migration-runner.js'

export async function openRepositoryTestDatabase(): Promise<{ database: Database.Database; directory: string }> {
  closeDatabaseConnection()
  const directory = await mkdtemp(join(tmpdir(), 'xiaodou-repository-'))
  const database = createDatabaseConnection(join(directory, 'repository.db'))
  runMigration(database)
  return { database, directory }
}

export async function closeRepositoryTestDatabase(directory: string): Promise<void> {
  closeDatabaseConnection()
  await rm(directory, { recursive: true, force: true })
}

export function insertTestFile(database: Database.Database, id = 'file_001'): void {
  database.prepare(`INSERT INTO files (id, file_name, file_type, file_size, storage_path) VALUES (?, ?, ?, ?, ?)`).run(id, `${id}.pdf`, 'application/pdf', 10, `uploads/${id}.pdf`)
}

export function insertTestTask(database: Database.Database, id: string, fileId: string, requestId = `request_${id}`): void {
  database.prepare(`INSERT INTO tasks (id, file_id, request_id) VALUES (?, ?, ?)`).run(id, fileId, requestId)
}
