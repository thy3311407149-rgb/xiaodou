import { Router, type RequestHandler } from 'express'
import multer from 'multer'
import { config } from '../core/config.js'
import { ApplicationError } from '../core/errors/application-error.js'
import { toPublicSummary } from './summary-response.js'
import { toPublicTask } from './task-response.js'
import { RecordingService } from '../services/recording-service.js'

type RecordingRouterOptions = {
  recordingService?: RecordingService
  maxFileSizeBytes?: number
}

function uploadMiddleware(maxFileSizeBytes: number): RequestHandler {
  const upload = multer({
    defParamCharset: 'utf8',
    storage: multer.memoryStorage(),
    limits: { fileSize: maxFileSizeBytes },
  })
  return (request, response, next) => {
    upload.single('audio')(request, response, (error: unknown) => {
      if (!error) {
        next()
        return
      }
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        next(new ApplicationError('FILE_TOO_LARGE'))
        return
      }
      next(new ApplicationError('INVALID_REQUEST', { cause: error }))
    })
  }
}

export function createRecordingRouter(options: RecordingRouterOptions = {}): Router {
  const router = Router()
  let service = options.recordingService
  const maxFileSizeBytes = options.maxFileSizeBytes ?? config.maxFileSizeBytes
  const getService = (): RecordingService => {
    service ??= new RecordingService()
    return service
  }

  router.get('/api/recordings', (request, response, next) => {
    try {
      const page = readPage(request.query.page, 1)
      const pageSize = readPage(request.query.pageSize, 20, 100)
      const listed = getService().list({ page, pageSize })
      response.json({ requestId: request.requestId, data: listed })
    } catch (error: unknown) {
      next(error)
    }
  })

  router.post('/api/recordings', (request, response, next) => {
    try {
      const title = typeof request.body?.title === 'string' ? request.body.title : undefined
      const created = getService().create({ requestId: request.requestId, title })
      response.status(201).json({
        requestId: request.requestId,
        data: { recording: created.recording, knowledgeItemId: created.knowledgeItemId },
      })
    } catch (error: unknown) {
      next(error)
    }
  })

  router.get('/api/recordings/:recordingId', (request, response, next) => {
    try {
      const detail = getService().get(request.params.recordingId)
      response.json({
        requestId: request.requestId,
        data: {
          recording: detail.recording,
          knowledgeItemId: detail.knowledgeItemId,
          chunks: detail.chunks.map(toPublicChunk),
          segments: detail.segments,
          knowledgePoints: getService().listKnowledgePoints(detail.recording.id),
          summary: detail.summary ? { ...toPublicSummary(detail.summary), recordingId: detail.summary.recordingId } : null,
          task: detail.task ? toPublicTask(detail.task) : null,
        },
      })
    } catch (error: unknown) {
      next(error)
    }
  })

  router.post('/api/recordings/:recordingId/start', async (request, response, next) => {
    try {
      const recording = await getService().start(request.params.recordingId)
      response.json({ requestId: request.requestId, data: { recording } })
    } catch (error: unknown) {
      next(error)
    }
  })

  router.post('/api/recordings/:recordingId/chunks', uploadMiddleware(maxFileSizeBytes), async (request, response, next) => {
    try {
      if (!request.file) throw new ApplicationError('INVALID_REQUEST', { message: '缺少 audio 字段' })
      const sequence = Number(request.body?.sequence)
      const declaredRate = Number(request.body?.sampleRate)
      const saved = await getService().appendChunk(pathParam(request.params.recordingId), {
        sequence,
        audio: request.file.buffer,
        mimeType: request.file.mimetype || 'application/octet-stream',
        sampleRate: Number.isInteger(declaredRate) && declaredRate > 0 ? declaredRate : undefined,
      })
      response.status(201).json({
        requestId: request.requestId,
        data: { chunk: toPublicChunk(saved.chunk), segments: saved.segments },
      })
    } catch (error: unknown) {
      next(error)
    }
  })

  router.get('/api/recordings/:recordingId/chunks/:sequence', async (request, response, next) => {
    try {
      const sequence = Number(request.params.sequence)
      const audio = await getService().readChunk(request.params.recordingId, sequence)
      response.setHeader('Content-Type', audio.mimeType)
      response.send(audio.bytes)
    } catch (error: unknown) {
      next(error)
    }
  })

  router.post('/api/recordings/:recordingId/pause', async (request, response, next) => {
    try {
      const recording = await getService().pause(request.params.recordingId)
      response.json({ requestId: request.requestId, data: { recording } })
    } catch (error: unknown) {
      next(error)
    }
  })

  router.post('/api/recordings/:recordingId/resume', async (request, response, next) => {
    try {
      const recording = await getService().resume(request.params.recordingId)
      response.json({ requestId: request.requestId, data: { recording } })
    } catch (error: unknown) {
      next(error)
    }
  })

  router.post('/api/recordings/:recordingId/finish', async (request, response, next) => {
    try {
      const finished = await getService().finish(request.params.recordingId, request.requestId)
      response.json({
        requestId: request.requestId,
        data: { recording: finished.recording, task: toPublicTask(finished.task) },
      })
    } catch (error: unknown) {
      next(error)
    }
  })

  router.post('/api/recordings/:recordingId/process', (request, response, next) => {
    try {
      const task = getService().process(request.params.recordingId, request.requestId)
      response.status(201).json({ requestId: request.requestId, data: { task: toPublicTask(task) } })
    } catch (error: unknown) {
      next(error)
    }
  })

  router.delete('/api/recordings/:recordingId', async (request, response, next) => {
    try {
      await getService().remove(request.params.recordingId)
      response.json({ requestId: request.requestId, data: { recordingId: request.params.recordingId, status: 'DELETED' } })
    } catch (error: unknown) {
      next(error)
    }
  })

  return router
}

function readPage(value: unknown, fallback: number, max?: number): number {
  if (value === undefined) return fallback
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) {
    throw new ApplicationError('INVALID_REQUEST', { message: '分页参数无效' })
  }
  const parsed = Number(raw)
  if (max !== undefined && parsed > max) throw new ApplicationError('INVALID_REQUEST', { message: '分页参数无效' })
  return parsed
}

function pathParam(value: string | string[] | undefined): string {
  const param = Array.isArray(value) ? value[0] : value
  if (!param) throw new ApplicationError('INVALID_REQUEST')
  return param
}

function toPublicChunk(chunk: { id: string; recordingId: string; sequence: number; byteSize: number; sha256: string; mimeType: string; asrStatus: string; createdAt: string }) {
  return {
    id: chunk.id,
    recordingId: chunk.recordingId,
    sequence: chunk.sequence,
    byteSize: chunk.byteSize,
    sha256: chunk.sha256,
    mimeType: chunk.mimeType,
    asrStatus: chunk.asrStatus,
    createdAt: chunk.createdAt,
  }
}
