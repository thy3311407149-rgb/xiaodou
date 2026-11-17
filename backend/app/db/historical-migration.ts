import type Database from 'better-sqlite3'
import { HISTORICAL_MIGRATION_CHECKSUMS } from './historical-checksums.js'
import { compareToBaseline, loadBaselineSnapshot } from './schema-baseline.js'
import { tokenizeSql } from './sql-normalizer.js'

const additiveColumnPattern = /ALTER TABLE\s+(\w+)\s+ADD COLUMN(?:\s+IF NOT EXISTS)?\s+(\w+)\s+([^;]+);/g

const recordingsColumnsBeforeRebuild = new Set([
  'id',
  'status',
  'created_at',
  'updated_at',
  'title',
  'mime_type',
  'sample_rate',
  'started_at',
  'ended_at',
  'interrupted_at',
  'error_code',
  'error_message',
])

const summaryColumnsBeforeRebuild = new Set([
  'id',
  'file_id',
  'task_id',
  'content',
  'key_points',
  'citations',
  'model_name',
  'prompt_version',
  'input_tokens',
  'output_tokens',
  'created_at',
  'updated_at',
  'recording_id',
])

export type HistoricalAction = 'record-only' | 'execute' | 'refuse'

export function executeHistoricalMigration(
  database: Database.Database,
  filename: string,
  sql: string,
): 'executed' | 'skipped' {
  if (filename === '003_task_type_extension.sql' && tableHasColumn(database, 'tasks', 'recording_id')) {
    return 'skipped'
  }
  database.exec(applyAdditiveColumns(database, sql))
  return 'executed'
}

export function applyAdditiveColumns(database: Database.Database, sql: string): string {
  return sql.replace(additiveColumnPattern, (_statement, table: string, column: string, definition: string) => {
    if (!tableHasColumn(database, table, column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition.trim()};`)
    }
    return ''
  })
}

export function historicalAction(database: Database.Database, version: string): HistoricalAction {
  const entry = HISTORICAL_MIGRATION_CHECKSUMS.find((item) => item.version === version)
  if (!entry) return 'refuse'
  if (isHistoricalVersionApplied(database, version)) return 'record-only'
  if (isHistoricalVersionExecutable(database, version)) return 'execute'
  return 'refuse'
}

function isHistoricalVersionApplied(database: Database.Database, version: string): boolean {
  const files = columnNames(database, 'files')
  const tasks = columnNames(database, 'tasks')
  const chunks = columnNames(database, 'text_chunks')
  const recordings = columnNames(database, 'recordings')
  const summaries = columnNames(database, 'summaries')
  if (version === '001') return files !== null && tasks !== null
  if (version === '002') return columnNames(database, 'knowledge_items') !== null && chunks?.includes('note_id') === true
  if (version === '003') {
    return tasks?.includes('recording_id') === true || sqlHasToken(tableSql(database, 'tasks') ?? '', 'PROCESS_RECORDING')
  }
  if (version === '004') {
    return recordings !== null && columnNames(database, 'notes') !== null && tasks?.includes('recording_id') === true
  }
  if (version === '005') {
    return columnNames(database, 'recording_audio_chunks') !== null
      && columnNames(database, 'transcript_segments') !== null
      && columnNames(database, 'knowledge_points') !== null
      && recordings?.includes('title') === true
      && summaries?.includes('recording_id') === true
  }
  if (version === '006') return compareToBaseline(database).length === 0
  return false
}

function isHistoricalVersionExecutable(database: Database.Database, version: string): boolean {
  if (version === '001') return columnNames(database, 'files') === null
  if (version === '002') return isHistoricalVersionApplied(database, '001')
  if (version === '003') return isHistoricalVersionApplied(database, '002')
  if (version === '004') return isHistoricalVersionApplied(database, '003') || columnNames(database, 'tasks')?.includes('recording_id') === true
  if (version === '005') return isRecordingRebuildSafe(database) && isSummaryRebuildSafe(database)
  if (version === '006') return isPauseRebuildSafe(database)
  return false
}

function isRecordingRebuildSafe(database: Database.Database): boolean {
  if (columnNames(database, 'recording_audio_chunks') !== null) return false
  const recordings = columnNames(database, 'recordings')
  if (!recordings) return false
  const required = ['id', 'status', 'created_at', 'updated_at']
  return required.every((name) => recordings.includes(name))
    && recordings.every((name) => recordingsColumnsBeforeRebuild.has(name))
}

function isSummaryRebuildSafe(database: Database.Database): boolean {
  const summaries = columnNames(database, 'summaries')
  if (!summaries) return false
  return summaries.includes('id') && summaries.includes('file_id')
    && summaries.every((name) => summaryColumnsBeforeRebuild.has(name))
}

function isPauseRebuildSafe(database: Database.Database): boolean {
  if (!isHistoricalVersionApplied(database, '005')) return false
  const recordings = columnNames(database, 'recordings')
  const expected = loadBaselineSnapshot().tables.recordings?.columns.map((column) => column.name) ?? []
  if (!recordings || recordings.join('\0') !== expected.join('\0')) return false
  const sql = tableSql(database, 'recordings') ?? ''
  return sqlHasToken(sql, 'RECORDING') && !sqlHasToken(sql, 'PAUSED')
}

function tableHasColumn(database: Database.Database, table: string, column: string): boolean {
  return columnNames(database, table)?.includes(column) === true
}

function columnNames(database: Database.Database, table: string): string[] | null {
  const exists = database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)
  if (!exists) return null
  const columns = database.pragma(`table_info(${table})`) as Array<{ name: string }>
  return columns.map((column) => column.name)
}

function tableSql(database: Database.Database, table: string): string | null {
  const row = database.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { sql: string | null } | undefined
  return row?.sql ?? null
}

function sqlHasToken(sql: string, token: string): boolean {
  return tokenizeSql(sql).some((item) => item === token || item === `'${token}'` || item === `"${token}"`)
}
