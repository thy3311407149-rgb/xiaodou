import 'dotenv/config'

export type AppConfig = {
  appEnv: string
  databasePath: string
  uploadDir: string
  maxFileSizeBytes: number
  port: number
  host: string
  llmBaseUrl: string
  llmApiKey: string
  llmModel: string
  llmTimeoutMs: number
  llmMaxRetries: number
}

export const config: AppConfig = {
  appEnv: process.env.APP_ENV ?? 'development',
  databasePath: process.env.DATABASE_PATH ?? './data/app.db',
  uploadDir: process.env.UPLOAD_DIR ?? './uploads',
  maxFileSizeBytes: Number(process.env.MAX_FILE_SIZE_BYTES ?? 20 * 1024 * 1024),
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '127.0.0.1',
  llmBaseUrl: process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1',
  llmApiKey: process.env.LLM_API_KEY ?? '',
  llmModel: process.env.LLM_MODEL ?? 'gpt-4o-mini',
  llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 30_000),
  llmMaxRetries: Number(process.env.LLM_MAX_RETRIES ?? 2),
}
