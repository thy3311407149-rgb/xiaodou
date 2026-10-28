import { Router, type RequestHandler } from 'express'
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import { createReadStream, mkdirSync, unlink } from 'node:fs'
import { join } from 'node:path'
import { config } from '../core/config.js'
import { ApplicationError } from '../core/errors/application-error.js'
import { toPublicSummary } from './summary-response.js'
import { toPublicTask } from './task-response.js'
import { FileService } from '../services/file-service.js'

type FileRouterOptions = {
  fileService?: FileService
  uploadDir?: string
  maxFileSizeBytes?: number
}

function uploadMiddleware(uploadDirectory: string, maxFileSizeBytes: number): RequestHandler {
  const upload = multer({
    // Browsers send UTF-8 bytes in the multipart filename parameter.
    // Busboy otherwise decodes that parameter as Latin-1 and stores mojibake.
    defParamCharset: 'utf8',
    storage: multer.diskStorage({
      destination: (_request, _file, callback) => {
        const temporaryDirectory = join(uploadDirectory, '.tmp')
        mkdirSync(temporaryDirectory, { recursive: true })
        callback(null, temporaryDirectory)
      },
      filename: (_request, _file, callback) => callback(null, `${randomUUID()}.upload`),
    }),
    limits: { fileSize: maxFileSizeBytes },
    fileFilter: (_request, file, callback) => {
      const extension = file.originalname.toLowerCase().endsWith('.pdf')
      if (file.mimetype !== 'application/pdf' || !extension) {
        callback(new ApplicationError('INVALID_FILE_TYPE'))
        return
      }
      callback(null, true)
    },
  })

  return (request, response, next) => {
    upload.single('file')(request, response, (error: unknown) => {
      if (!error) {
        next()
        return
      }
      if (error instanceof ApplicationError) {
        next(error)
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

export function createFileRouter(options: FileRouterOptions = {}): Router {
  const router = Router()
  let service = options.fileService
  const uploadDirectory = options.uploadDir ?? config.uploadDir
  const maxFileSizeBytes = options.maxFileSizeBytes ?? config.maxFileSizeBytes
  const getService = (): FileService => {
    service ??= new FileService({ uploadDir: uploadDirectory })
    return service
  }

  router.post('/api/files', uploadMiddleware(uploadDirectory, maxFileSizeBytes), async (request, response, next) => {
    try {
      if (!request.file) {
        throw new ApplicationError('INVALID_REQUEST', { message: '缺少 file 字段' })
      }
      if (request.file.size === 0) {
        unlink(request.file.path, () => undefined)
        throw new ApplicationError('INVALID_REQUEST', { message: '文件不能为空' })
      }

      const uploaded = await getService().upload({
        temporaryPath: request.file.path,
        originalName: request.file.originalname,
        mimeType: request.file.mimetype,
        size: request.file.size,
        requestId: request.requestId,
      })

      response.status(201).json({
        requestId: request.requestId,
        data: { file: uploaded.file, task: toPublicTask(uploaded.task) },
      })
    } catch (error: unknown) {
      next(error)
    }
  })

  router.get('/api/files', (request, response) => {
    const page = Math.max(Number(request.query.page ?? 1), 1)
    const pageSize = Math.min(Math.max(Number(request.query.pageSize ?? 20), 1), 100)
    const items = getService().list('demo-user', pageSize, (page - 1) * pageSize)
    response.json({ requestId: request.requestId, data: { items, page, pageSize, total: items.length } })
  })

  router.get('/api/files/:fileId/document-text', (request, response, next) => {
    try {
      const pages = getService().getDocumentText(request.params.fileId)
      response.json({ requestId: request.requestId, data: { pages } })
    } catch (error: unknown) {
      next(error)
    }
  })

  router.get('/api/files/:fileId/content', async (request, response, next) => {
    try {
      const absolutePath = await getService().openPdf(request.params.fileId)
      response.type('application/pdf')
      const stream = createReadStream(absolutePath)
      stream.on('error', (error: unknown) => {
        if (!response.headersSent) next(error)
        else response.destroy()
      })
      stream.pipe(response)
    } catch (error: unknown) {
      next(error)
    }
  })

  router.get('/api/files/:fileId', (request, response, next) => {
    try {
      const detail = getService().getDetail(request.params.fileId)
      response.json({
        requestId: request.requestId,
        data: {
          file: detail.file,
          task: detail.task ? toPublicTask(detail.task) : null,
          summary: detail.summary ? toPublicSummary(detail.summary) : null,
        },
      })
    } catch (error: unknown) {
      next(error)
    }
  })

  router.delete('/api/files/:fileId', async (request, response, next) => {
    try {
      const file = await getService().delete(request.params.fileId, request.requestId)
      response.json({ requestId: request.requestId, data: { fileId: file.id, status: file.status } })
    } catch (error: unknown) {
      next(error)
    }
  })

  return router
}

export const fileRouter = createFileRouter()
