import express from 'express'
import { healthRouter } from './api/health.js'
import { config } from './core/config.js'
import { createCorsMiddleware } from './core/cors-middleware.js'
import { errorHandler } from './core/errors/error-handler.js'
import { requestIdMiddleware } from './core/request-id-middleware.js'
import { requestLoggingMiddleware } from './core/request-logging-middleware.js'
import { fileRouter } from './api/files.js'
import { knowledgeRouter } from './api/knowledge.js'
import { createNoteRouter } from './api/notes.js'
import { createRecordingRouter } from './api/recordings.js'
import { taskRouter } from './api/tasks.js'
import type { NoteService } from './services/note-service.js'
import type { RecordingService } from './services/recording-service.js'

type CreateAppOptions = {
  allowedOrigins?: readonly string[]
  allowPrivateNetworkOrigins?: boolean
  recordingService?: RecordingService
  noteService?: NoteService
}

export function createApp(options: CreateAppOptions = {}) {
  const app = express()
  const allowPrivateNetworkOrigins = options.allowPrivateNetworkOrigins ?? config.appEnv !== 'production'
  app.use(createCorsMiddleware(options.allowedOrigins ?? config.corsAllowedOrigins, { allowPrivateNetworkOrigins }))
  app.use(express.json())
  app.use(requestIdMiddleware)
  app.use(requestLoggingMiddleware)
  app.use(healthRouter)
  app.use(fileRouter)
  app.use(createRecordingRouter({ recordingService: options.recordingService }))
  app.use(createNoteRouter({ noteService: options.noteService }))
  app.use(taskRouter)
  app.use(knowledgeRouter)
  app.use(errorHandler)
  return app
}
