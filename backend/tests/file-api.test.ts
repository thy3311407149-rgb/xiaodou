import express from 'express'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFileRouter } from '../app/api/files.js'
import { errorHandler } from '../app/core/errors/error-handler.js'
import { requestIdMiddleware } from '../app/core/request-id-middleware.js'
import { requestLoggingMiddleware } from '../app/core/request-logging-middleware.js'
import { closeDatabaseConnection, createDatabaseConnection } from '../app/db/connection.js'
import { FileService } from '../app/services/file-service.js'
import { OperationLogger } from '../app/services/operation-logger.js'
import { FileRepository } from '../app/repositories/file-repository.js'
import { OperationLogRepository } from '../app/repositories/operation-log-repository.js'
import { closeRepositoryTestDatabase, openRepositoryTestDatabase } from './repository-test-helper.js'

const fixturePath = resolve('tests/fixtures/minimal.pdf')
let databaseDirectory = ''
let uploadDirectory = ''

afterEach(async () => {
  if (databaseDirectory) {
    await closeRepositoryTestDatabase(databaseDirectory)
    databaseDirectory = ''
  } else {
    closeDatabaseConnection()
  }
  if (uploadDirectory) {
    await rm(uploadDirectory, { recursive: true, force: true })
    uploadDirectory = ''
  }
})

async function createTestContext() {
  const databaseContext = await openRepositoryTestDatabase()
  databaseDirectory = databaseContext.directory
  uploadDirectory = await mkdtemp(join(tmpdir(), 'xiaodou-uploads-'))
  const fileRepository = new FileRepository(databaseContext.database)
  const operationLogger = new OperationLogger(new OperationLogRepository(databaseContext.database))
  const service = new FileService({ database: databaseContext.database, fileRepository, operationLogger, uploadDir: uploadDirectory })
  const app = express()
  app.use(express.json())
  app.use(requestIdMiddleware)
  app.use(requestLoggingMiddleware)
  app.use(createFileRouter({ fileService: service, uploadDir: uploadDirectory, maxFileSizeBytes: 1024 }))
  app.use(errorHandler)
  return { app, database: databaseContext.database, service, fileRepository, operationLogger }
}

describe('File API', () => {
  it('uploads a PDF, lists it, gets details, and deletes it safely', async () => {
    const context = await createTestContext()
    const uploadResponse = await request(context.app)
      .post('/api/files')
      .set('X-Request-Id', 'req_file_upload_001')
      .attach('file', fixturePath, { filename: '../../test.pdf', contentType: 'application/pdf' })

    expect(uploadResponse.status).toBe(201)
    expect(uploadResponse.headers['x-request-id']).toBe('req_file_upload_001')
    expect(uploadResponse.body.data.file).toMatchObject({ fileName: 'test.pdf', fileType: 'application/pdf', status: 'UPLOADED' })
    const fileId = uploadResponse.body.data.file.id as string
    const storagePath = uploadResponse.body.data.file.storagePath as string
    expect(storagePath).not.toContain('test.pdf')
    const savedPath = resolve(process.cwd(), storagePath)
    expect(await readFile(savedPath)).toEqual(await readFile(fixturePath))
    expect(context.fileRepository.findById(fileId)?.fileName).toBe('test.pdf')
    const uploadLogs = new OperationLogRepository(context.database).findByRequestId('req_file_upload_001')
    expect(uploadLogs.map((log) => log.operation)).toEqual(expect.arrayContaining(['FILE_UPLOAD_STARTED', 'FILE_UPLOAD_COMPLETED']))
    expect(uploadLogs.some((log) => log.fileId === fileId && log.operation === 'FILE_UPLOAD_COMPLETED')).toBe(true)

    const listResponse = await request(context.app).get('/api/files').set('X-Request-Id', 'req_file_list_001')
    expect(listResponse.status).toBe(200)
    expect(listResponse.body.data.items.map((item: { id: string }) => item.id)).toContain(fileId)

    const detailResponse = await request(context.app).get(`/api/files/${fileId}`)
    expect(detailResponse.status).toBe(200)
    expect(detailResponse.body.data.file.id).toBe(fileId)
    expect(detailResponse.body.data.summary).toBeNull()
    expect(detailResponse.body.data.task).toMatchObject({
      id: uploadResponse.body.data.task.id,
      fileId,
      taskType: 'PROCESS_PDF',
      status: 'QUEUED',
      currentStep: 'EXTRACT_TEXT',
      progress: 0,
    })

    const deleteResponse = await request(context.app).delete(`/api/files/${fileId}`).set('X-Request-Id', 'req_file_delete_001')
    expect(deleteResponse.status).toBe(200)
    expect(deleteResponse.body.data.status).toBe('DELETED')
    expect(context.fileRepository.findById(fileId)?.status).toBe('DELETED')
    await expect(readFile(savedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(request(context.app).get(`/api/files/${fileId}`)).resolves.toMatchObject({ status: 404 })
  })

  it('stores and returns a Chinese file name without changing the storage path', async () => {
    const context = await createTestContext()
    const fileName = '课堂笔记.pdf'
    const boundary = '----ChineseFileName'
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/pdf\r\n\r\n`,
        'utf8',
      ),
      await readFile(fixturePath),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ])

    const uploadResponse = await request(context.app)
      .post('/api/files')
      .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
      .send(body)

    expect(uploadResponse.status).toBe(201)
    const file = uploadResponse.body.data.file as { id: string; fileName: string; storagePath: string }
    expect(file.fileName).toBe(fileName)
    expect(file.storagePath.endsWith(`${file.id}.pdf`)).toBe(true)
    expect(file.storagePath).not.toContain('笔记')
    expect(context.fileRepository.findById(file.id)?.fileName).toBe(fileName)

    const detailResponse = await request(context.app).get(`/api/files/${file.id}`)
    expect(detailResponse.status).toBe(200)
    expect(detailResponse.body.data.file.fileName).toBe(fileName)

    const listResponse = await request(context.app).get('/api/files')
    expect(listResponse.body.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: file.id, fileName }),
    ]))
  })

  it('rejects invalid type, wrong extension, empty file, and oversized file', async () => {
    const context = await createTestContext()
    const invalidType = await request(context.app).post('/api/files').attach('file', fixturePath, { filename: 'file.txt', contentType: 'text/plain' })
    expect(invalidType.status).toBe(400)
    expect(invalidType.body.error.code).toBe('INVALID_FILE_TYPE')

    const wrongExtension = await request(context.app).post('/api/files').attach('file', fixturePath, { filename: 'file.txt', contentType: 'application/pdf' })
    expect(wrongExtension.status).toBe(400)
    expect(wrongExtension.body.error.code).toBe('INVALID_FILE_TYPE')

    const emptyPath = join(uploadDirectory, 'empty.pdf')
    await writeFile(emptyPath, '')
    const empty = await request(context.app).post('/api/files').attach('file', emptyPath, { filename: 'empty.pdf', contentType: 'application/pdf' })
    expect(empty.status).toBe(400)
    expect(empty.body.error.code).toBe('INVALID_REQUEST')

    const oversizedPath = join(uploadDirectory, 'large.pdf')
    await writeFile(oversizedPath, Buffer.alloc(2048, 1))
    const oversized = await request(context.app).post('/api/files').attach('file', oversizedPath, { filename: 'large.pdf', contentType: 'application/pdf' })
    expect(oversized.status).toBe(413)
    expect(oversized.body.error.code).toBe('FILE_TOO_LARGE')
  })

  it('returns FILE_NOT_FOUND for a missing file', async () => {
    const context = await createTestContext()
    const response = await request(context.app).get('/api/files/file_missing')
    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('FILE_NOT_FOUND')
  })

  it('keeps the database DELETED when local deletion fails and logs the failure', async () => {
    const context = await createTestContext()
    const uploadResponse = await request(context.app).post('/api/files').attach('file', fixturePath, { filename: 'delete-failure.pdf', contentType: 'application/pdf' })
    const fileId = uploadResponse.body.data.file.id as string
    context.database.prepare('UPDATE files SET storage_path = ? WHERE id = ?').run('uploads/path-that-does-not-exist.pdf', fileId)

    const response = await request(context.app).delete(`/api/files/${fileId}`).set('X-Request-Id', 'req_delete_failed_001')
    expect(response.status).toBe(200)
    expect(context.fileRepository.findById(fileId)?.status).toBe('DELETED')
    const logs = new OperationLogRepository(context.database).findByRequestId('req_delete_failed_001')
    expect(logs.at(-1)).toMatchObject({ operation: 'FILE_DELETE_FAILED', status: 'FAILED', fileId })
  })

  it('stores the temporary upload and the final PDF under the configured UPLOAD_DIR', async () => {
    const databaseContext = await openRepositoryTestDatabase()
    databaseDirectory = databaseContext.directory
    uploadDirectory = await mkdtemp(join(tmpdir(), 'xiaodou-volume-'))
    const app = express()
    app.use(express.json())
    app.use(requestIdMiddleware)
    app.use(createFileRouter({ uploadDir: uploadDirectory }))
    app.use(errorHandler)

    const response = await request(app)
      .post('/api/files')
      .attach('file', fixturePath, { filename: 'volume.pdf', contentType: 'application/pdf' })

    expect(response.status).toBe(201)
    const fileId = response.body.data.file.id as string
    const storagePath = response.body.data.file.storagePath as string
    const savedPath = resolve(process.cwd(), storagePath)
    expect(savedPath).toBe(resolve(uploadDirectory, `${fileId}.pdf`))
    expect(await readFile(savedPath)).toEqual(await readFile(fixturePath))
    expect((await stat(join(uploadDirectory, '.tmp'))).isDirectory()).toBe(true)
    await expect(stat(resolve('uploads', `${fileId}.pdf`))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans up the saved file when database creation fails', async () => {
    const context = await createTestContext()
    vi.spyOn(context.fileRepository, 'create').mockImplementation(() => { throw new Error('database unavailable') })
    const response = await request(context.app).post('/api/files').attach('file', fixturePath, { filename: 'db-failure.pdf', contentType: 'application/pdf' })
    expect(response.status).toBe(500)
    expect(response.body.error.code).toBe('FILE_SAVE_FAILED')
    const remainingFiles = await import('node:fs/promises').then(({ readdir }) => readdir(uploadDirectory, { recursive: true }))
    expect(remainingFiles.filter((name) => String(name).endsWith('.pdf'))).toEqual([])
  })
})
