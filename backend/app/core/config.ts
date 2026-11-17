import { config as loadEnv } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') })

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
  llmMaxOutputTokens: number
  llmTemperature: number
  corsAllowedOrigins: string[]
  asrApiKey: string
  asrModel: string
  asrWsUrl: string
  asrSampleRate: number
  recordingDir: string
}

export function readAllowedOrigins(value: string | undefined): string[] {
  if (!value) return []
  const origins: string[] = []
  for (const part of value.split(',')) {
    const origin = part.trim()
    if (!origin || origin.includes('*')) continue
    origins.push(origin)
  }
  return origins
}

export function createConfig(env: NodeJS.ProcessEnv): AppConfig {
  return {
    appEnv: env.APP_ENV ?? 'development',
    databasePath: env.DATABASE_PATH ?? './data/app.db',
    uploadDir: env.UPLOAD_DIR ?? './uploads',
    maxFileSizeBytes: Number(env.MAX_FILE_SIZE_BYTES ?? 20 * 1024 * 1024),
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '127.0.0.1',
    llmBaseUrl: env.LLM_BASE_URL ?? 'https://api.openai.com/v1',
    llmApiKey: env.LLM_API_KEY ?? '',
    llmModel: env.LLM_MODEL ?? 'gpt-4o-mini',
    llmTimeoutMs: Number(env.LLM_TIMEOUT_MS ?? 180_000),
    llmMaxRetries: Number(env.LLM_MAX_RETRIES ?? 2),
    llmMaxOutputTokens: Number(env.LLM_MAX_OUTPUT_TOKENS ?? 8192),
    llmTemperature: Number(env.LLM_TEMPERATURE ?? 0.2),
    corsAllowedOrigins: readAllowedOrigins(env.CORS_ALLOWED_ORIGINS),
    asrApiKey: env.ASR_API_KEY ?? '',
    asrModel: env.ASR_MODEL ?? 'paraformer-realtime-v2',
    asrWsUrl: env.ASR_WS_URL ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
    asrSampleRate: Number(env.ASR_SAMPLE_RATE ?? 16000),
    recordingDir: env.RECORDING_DIR ?? `${env.UPLOAD_DIR ?? './uploads'}/recordings`,
  }
}

export const config: AppConfig = createConfig(process.env)
