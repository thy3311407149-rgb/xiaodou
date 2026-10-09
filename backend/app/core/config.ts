import 'dotenv/config'

export type AppConfig = {
  appEnv: string
  databasePath: string
  uploadDir: string
  maxFileSizeBytes: number
  port: number
  host: string
}

export const config: AppConfig = {
  appEnv: process.env.APP_ENV ?? 'development',
  databasePath: process.env.DATABASE_PATH ?? './data/app.db',
  uploadDir: process.env.UPLOAD_DIR ?? './uploads',
  maxFileSizeBytes: Number(process.env.MAX_FILE_SIZE_BYTES ?? 20 * 1024 * 1024),
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '127.0.0.1',
}
