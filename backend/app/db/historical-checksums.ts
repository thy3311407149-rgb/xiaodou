import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface HistoricalMigrationChecksum {
  version: string
  filename: string
  checksum: string
}

/**
 * SHA-256 of the historical migration bytes currently in the repository.
 * These constants are the trusted baseline. A changed file, including a
 * line-ending change, must fail verification instead of replacing them.
 */
export const HISTORICAL_MIGRATION_CHECKSUMS: readonly HistoricalMigrationChecksum[] = [
  {
    version: '001',
    filename: '001_initial_schema.sql',
    checksum: 'ba591007a84c27f2161cf69dfc44a3690d3e0d2f671311e91ae6716648568ec1',
  },
  {
    version: '002',
    filename: '002_unified_knowledge_items.sql',
    checksum: '88ddb733a3bd3181a388f51a3f8f09564e36c52f295a591b21a9edc5c6d90d6b',
  },
  {
    version: '003',
    filename: '003_task_type_extension.sql',
    checksum: 'ae139ed2c6a71b03f9aef6869be499e591ab504f56148ec6d989ad38e2432706',
  },
  {
    version: '004',
    filename: '004_task_source_association.sql',
    checksum: 'c8aa52fe1cd287446e665a361275b42ea327904bfa204796730ebace9bad251c',
  },
  {
    version: '005',
    filename: '005_recording_pipeline.sql',
    checksum: 'da690e951edd20a23a4dc2a915b0e73802c692ceb4d1654a08d68566b408c4f4',
  },
  {
    version: '006',
    filename: '006_recording_pause.sql',
    checksum: '2250133caa8e54e4840b10d81254b1baafb250f801479003153af87a938b0390',
  },
]

export class HistoricalChecksumError extends Error {
  readonly failures: readonly string[]

  constructor(failures: readonly string[]) {
    super(`Historical migration checksum verification failed: ${failures.join('; ')}`)
    this.name = 'HistoricalChecksumError'
    this.failures = failures
  }
}

export function sha256Bytes(bytes: Buffer | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function verifyHistoricalMigrationFiles(migrationsDirectory: string): void {
  const failures: string[] = []
  for (const entry of HISTORICAL_MIGRATION_CHECKSUMS) {
    const filePath = resolve(migrationsDirectory, entry.filename)
    let bytes: Buffer
    try {
      bytes = readFileSync(filePath)
    } catch (error: unknown) {
      failures.push(`${entry.filename} is missing (${error instanceof Error ? error.message : String(error)})`)
      continue
    }
    const actual = sha256Bytes(bytes)
    if (actual !== entry.checksum) {
      failures.push(`${entry.filename} checksum ${actual} does not match trusted checksum ${entry.checksum}`)
    }
  }
  if (failures.length > 0) {
    throw new HistoricalChecksumError(failures)
  }
}
