import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import { normalizeSql } from './sql-normalizer.js'

export const CORE_BUSINESS_TABLES = [
  'document_texts',
  'files',
  'knowledge_item_summaries',
  'knowledge_items',
  'knowledge_points',
  'notes',
  'operation_logs',
  'recording_audio_chunks',
  'recordings',
  'summaries',
  'tasks',
  'text_chunks',
  'transcript_segments',
] as const

export const MIGRATION_AUXILIARY_TABLES = [
  'schema_migration_lock',
  'schema_migration_state',
  'schema_migrations',
] as const

export interface BaselineColumn {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

export interface BaselineForeignKey {
  id: number
  seq: number
  table: string
  from: string
  to: string
  on_update: string
  on_delete: string
}

export interface BaselineIndexColumn {
  seqno: number
  name: string | null
  desc: number
}

export interface BaselineIndex {
  name: string
  unique: number
  origin: string
  partial: number
  columns: BaselineIndexColumn[]
  sql: string | null
}

export interface BaselineTrigger {
  name: string
  sql: string
}

export interface BaselineTable {
  columns: BaselineColumn[]
  foreignKeys: BaselineForeignKey[]
  sql: string
  indexes: BaselineIndex[]
  triggers: BaselineTrigger[]
}

export interface SchemaBaselineSnapshot {
  tables: Record<string, BaselineTable>
}

interface TableInfoRow {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
  hidden: number
}

interface ForeignKeyRow {
  id: number
  seq: number
  table: string
  from: string
  to: string
  on_update: string
  on_delete: string
}

interface IndexListRow {
  name: string
  unique: number
  origin: string
  partial: number
}

interface IndexColumnRow {
  seqno: number
  name: string | null
  desc: number
  key: number
}

interface NameSqlRow {
  name: string
  sql: string | null
}

const snapshotPath = fileURLToPath(new URL('./schema-baseline.snapshot.json', import.meta.url))

export function loadBaselineSnapshot(): SchemaBaselineSnapshot {
  return JSON.parse(readFileSync(snapshotPath, 'utf8')) as SchemaBaselineSnapshot
}

export function captureBaselineSnapshot(database: Database.Database): SchemaBaselineSnapshot {
  const tables: Record<string, BaselineTable> = {}
  for (const name of listUserTables(database)) {
    if (isAuxiliaryTable(name) || isTemporaryMigrationTable(name)) continue
    tables[name] = captureTable(database, name)
  }
  return { tables }
}

export function compareToBaseline(
  database: Database.Database,
  snapshot: SchemaBaselineSnapshot = loadBaselineSnapshot(),
): string[] {
  const violations: string[] = []
  const actualNames = listUserTables(database)
  const expectedNames = Object.keys(snapshot.tables).sort()

  for (const name of actualNames) {
    if (isTemporaryMigrationTable(name)) {
      violations.push(`temporary migration table ${name} is present`)
    }
  }

  for (const name of expectedNames) {
    if (!actualNames.includes(name)) {
      violations.push(`missing core table ${name}`)
    }
  }

  for (const name of expectedNames) {
    if (!actualNames.includes(name)) continue
    const expected = snapshot.tables[name]
    if (!expected) {
      violations.push(`baseline snapshot is missing ${name}`)
      continue
    }
    violations.push(...compareTable(captureTable(database, name), expected, name))
  }

  const foreignKeyViolations = database.pragma('foreign_key_check') as unknown[]
  if (foreignKeyViolations.length > 0) {
    violations.push('foreign_key_check returned one or more violations')
  }

  return violations
}

export function isAuxiliaryTable(name: string): boolean {
  return (MIGRATION_AUXILIARY_TABLES as readonly string[]).includes(name)
}

export function isTemporaryMigrationTable(name: string): boolean {
  return name.toLowerCase().endsWith('_new')
}

export function listBusinessTables(database: Database.Database): string[] {
  return listUserTables(database).filter((name) => !isAuxiliaryTable(name))
}

function listUserTables(database: Database.Database): string[] {
  const rows = database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>
  return rows.map((row) => row.name)
}

function captureTable(database: Database.Database, name: string): BaselineTable {
  const columns = (database.pragma(`table_xinfo(${quoteIdentifier(name)})`) as TableInfoRow[])
    .filter((column) => column.hidden === 0)
    .map((column) => ({
      cid: column.cid,
      name: column.name,
      type: column.type,
      notnull: column.notnull,
      dflt_value: column.dflt_value,
      pk: column.pk,
    }))

  const foreignKeys = (database.pragma(`foreign_key_list(${quoteIdentifier(name)})`) as ForeignKeyRow[])
    .map((key) => ({
      id: key.id,
      seq: key.seq,
      table: key.table,
      from: key.from,
      to: key.to,
      on_update: key.on_update,
      on_delete: key.on_delete,
    }))
    .sort((left, right) => left.id - right.id || left.seq - right.seq || left.from.localeCompare(right.from))

  const tableSql = database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name) as { sql: string | null }
  if (!tableSql.sql) {
    throw new Error(`SQLite did not store SQL for table ${name}`)
  }

  const indexes = (database.pragma(`index_list(${quoteIdentifier(name)})`) as IndexListRow[])
    .map((index) => {
      const columnsForIndex = (database.pragma(`index_xinfo(${quoteIdentifier(index.name)})`) as IndexColumnRow[])
        .filter((column) => column.key === 1)
        .sort((left, right) => left.seqno - right.seqno)
        .map((column) => ({ seqno: column.seqno, name: column.name, desc: column.desc }))
      const indexSql = database.prepare('SELECT sql FROM sqlite_master WHERE type = \'index\' AND name = ?').get(index.name) as { sql: string | null } | undefined
      return {
        name: index.name,
        unique: index.unique,
        origin: index.origin,
        partial: index.partial,
        columns: columnsForIndex,
        sql: indexSql?.sql ? normalizeSql(indexSql.sql) : null,
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name))

  const triggers = (database.prepare(`
    SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name
  `).all(name) as NameSqlRow[])
    .map((trigger) => ({
      name: trigger.name,
      sql: normalizeSql(trigger.sql ?? ''),
    }))

  return {
    columns,
    foreignKeys,
    sql: normalizeSql(tableSql.sql),
    indexes,
    triggers,
  }
}

function compareTable(actual: BaselineTable, expected: BaselineTable, tableName: string): string[] {
  const violations: string[] = []
  if (!sameJson(actual.columns, expected.columns)) {
    violations.push(`${tableName} columns differ from the 006 baseline`)
  }
  if (!sameJson(actual.foreignKeys, expected.foreignKeys)) {
    violations.push(`${tableName} foreign keys differ from the 006 baseline`)
  }
  if (actual.sql !== expected.sql) {
    violations.push(`${tableName} table SQL differs from the 006 baseline`)
  }

  const expectedByName = new Map(expected.indexes.map((index) => [index.name, index]))
  for (const expectedIndex of expected.indexes) {
    if (expectedIndex.origin === 'c') {
      const actualIndex = actual.indexes.find((index) => index.name === expectedIndex.name)
      if (!actualIndex || !sameIndex(actualIndex, expectedIndex)) {
        violations.push(`${tableName} index ${expectedIndex.name} differs from the 006 baseline`)
      }
      continue
    }
    const actualIndex = actual.indexes.find((index) => index.origin === expectedIndex.origin && sameIndexColumns(index, expectedIndex))
    if (!actualIndex) {
      violations.push(`${tableName} ${expectedIndex.origin} index on (${expectedIndex.columns.map((column) => column.name).join(', ')}) is missing`)
    }
  }

  for (const actualIndex of actual.indexes) {
    if (actualIndex.origin === 'c' && actualIndex.unique === 1 && !expectedByName.has(actualIndex.name)) {
      violations.push(`${tableName} has extra unique index ${actualIndex.name}`)
    }
  }

  const expectedTriggers = new Map(expected.triggers.map((trigger) => [trigger.name, trigger.sql]))
  for (const trigger of actual.triggers) {
    const expectedSql = expectedTriggers.get(trigger.name)
    if (expectedSql === undefined) {
      violations.push(`${tableName} has extra trigger ${trigger.name}`)
      continue
    }
    if (expectedSql !== trigger.sql) {
      violations.push(`${tableName} trigger ${trigger.name} differs from the 006 baseline`)
    }
  }
  for (const name of expectedTriggers.keys()) {
    if (!actual.triggers.some((trigger) => trigger.name === name)) {
      violations.push(`${tableName} trigger ${name} is missing`)
    }
  }

  return violations
}

function sameIndex(actual: BaselineIndex, expected: BaselineIndex): boolean {
  return actual.unique === expected.unique
    && actual.partial === expected.partial
    && actual.origin === expected.origin
    && actual.sql === expected.sql
    && sameIndexColumns(actual, expected)
}

function sameIndexColumns(actual: BaselineIndex, expected: BaselineIndex): boolean {
  return sameJson(actual.columns, expected.columns) && actual.unique === expected.unique
}

function sameJson(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new Error(`Unsafe SQLite identifier: ${name}`)
  }
  return name
}
