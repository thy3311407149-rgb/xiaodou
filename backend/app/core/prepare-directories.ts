import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { AppConfig } from './config.js'

export async function prepareDirectories(appConfig: AppConfig): Promise<void> {
  await mkdir(resolve(appConfig.uploadDir), { recursive: true })
  await mkdir(resolve(dirname(appConfig.databasePath)), { recursive: true })
}
