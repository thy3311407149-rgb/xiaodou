import express from 'express'
import { healthRouter } from './api/health.js'
import { errorHandler } from './core/errors/error-handler.js'
import { requestIdMiddleware } from './core/request-id-middleware.js'
import { requestLoggingMiddleware } from './core/request-logging-middleware.js'
import { fileRouter } from './api/files.js'

export function createApp() {
  const app = express()
  app.use(express.json())
  app.use(requestIdMiddleware)
  app.use(requestLoggingMiddleware)
  app.use(healthRouter)
  app.use(fileRouter)
  app.use(errorHandler)
  return app
}
