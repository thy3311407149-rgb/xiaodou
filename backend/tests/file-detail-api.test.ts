import type { IncomingMessage } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createFileRouter } from '../app/api/files.js'
import { errorHandler } from '../app/core/errors/error-handler.js'
import { requestIdMiddleware } from '../app/core/request-id-middleware.js'
import { requestLoggingMiddleware } from '../app/core/request-logging-middleware.js'
import { DocumentTextRepository } from '../app/repositories/document-text-repository.js'
import { FileRepository } from '../app/repositories/file-repository.js'
import { SummaryRepository } from '../app/repositories/summary-repository.js'
import { FileService } from '../app/services/file-service.js'
import { closeRepositoryTestDatabase, insertTestTask, openRepositoryTestDatabase } from './repository-test-helper.js'
import { createTextPdf } from './pdf-fixture.js'

let databaseDirectory = ''
let uploadDirectory = ''

afterEach(async () => {
  if (databaseDirectory) {
    await closeRepositoryTestDatabase(databaseDirectory)
    databaseDirectory = ''
  }
  if (uploadDirectory) {
    await rm(join(uploadDirectory, '..', 'secret-outside.pdf'), { force: true })
    await rm(uploadDirectory, { recursive: true, force: true })
    uploadDirectory = ''
  }
})

const readBinary = ((response: IncomingMessage, callback: (error: Error | null, body: Buffer) => void): void => {
  const chunks: Buffer[] = []
  response.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)))
  response.on('end', () => callback(null, Buffer.concat(chunks)))
}) as never

async function createDetailContext() {
  const databaseContext = await openRepositoryTestDatabase()
  databaseDirectory = databaseContext.directory
  uploadDirectory = await mkdtemp(join(tmpdir(), 'xiaodou-detail-'))
  const fileRepository = new FileRepository(databaseContext.database)
  const service = new FileService({ database: databaseContext.database, fileRepository, uploadDir: uploadDirectory })
  const app = express()
  app.use(express.json())
  app.use(requestIdMiddleware)
  app.use(requestLoggingMiddleware)
  app.use(createFileRouter({ fileService: service, uploadDir: uploadDirectory }))
  app.use(errorHandler)
  return {
    app,
    database: databaseContext.database,
    documentTextRepository: new DocumentTextRepository(databaseContext.database),
    summaryRepository: new SummaryRepository(databaseContext.database),
  }
}

async function storePdf(fileId: string, fileName: string, pdf: Buffer): Promise<string> {
  const absolutePath = join(uploadDirectory, fileName)
  await writeFile(absolutePath, pdf)
  return relative(resolve(process.cwd()), absolutePath).replaceAll('\\', '/')
}

describe('file detail APIs', () => {
  it('returns three parsed pages in page order', async () => {
    const context = await createDetailContext()
    const fileId = 'file_three_pages'
    const pages = [
      { pageNumber: 1, content: 'alpha page one' },
      { pageNumber: 2, content: 'beta page two' },
      { pageNumber: 3, content: 'gamma page three' },
    ]
    const pdf = createTextPdf(pages.map((page) => page.content))
    const storagePath = await storePdf(fileId, 'text-3pages.pdf', pdf)
    context.database.prepare(`
      INSERT INTO files (id, file_name, file_type, file_size, storage_path, status)
      VALUES (?, 'text-3pages.pdf', 'application/pdf', ?, ?, 'EXTRACTED')
    `).run(fileId, pdf.length, storagePath)
    context.documentTextRepository.createMany([
      { id: 'page_3', fileId, pageNumber: 3, content: pages[2]?.content ?? '' },
      { id: 'page_1', fileId, pageNumber: 1, content: pages[0]?.content ?? '' },
      { id: 'page_2', fileId, pageNumber: 2, content: pages[1]?.content ?? '' },
    ])

    const response = await request(context.app).get(`/api/files/${fileId}/document-text`).set('X-Request-Id', 'req_document_text')

    expect(response.status).toBe(200)
    expect(response.body.requestId).toBe('req_document_text')
    expect(response.body.data.pages).toEqual(pages)
    expect(Object.keys(response.body.data.pages[0] as object).sort()).toEqual(['content', 'pageNumber'])
    expect(JSON.stringify(response.body)).not.toContain(storagePath)
  })

  it('serves the stored PDF and rejects a missing, deleted, or escaped path', async () => {
    const context = await createDetailContext()
    const fileId = 'file_pdf_content'
    const pdf = createTextPdf(['visible page'])
    const storagePath = await storePdf(fileId, `${fileId}.pdf`, pdf)
    context.database.prepare(`
      INSERT INTO files (id, file_name, file_type, file_size, storage_path, status)
      VALUES (?, 'visible.pdf', 'application/pdf', ?, ?, 'COMPLETED')
    `).run(fileId, pdf.length, storagePath)
    const outsidePdf = createTextPdf(['secret outside'])
    const outsidePath = join(uploadDirectory, '..', 'secret-outside.pdf')
    await writeFile(outsidePath, outsidePdf)

    const contentResponse = await request(context.app)
      .get(`/api/files/${fileId}/content`)
      .query({ path: outsidePath })
      .buffer(true)
      .parse(readBinary)
    expect(contentResponse.status).toBe(200)
    expect(contentResponse.headers['content-type']).toMatch(/application\/pdf/)
    expect(contentResponse.body).toEqual(pdf)
    expect(contentResponse.body.equals(outsidePdf)).toBe(false)

    const missing = await request(context.app).get('/api/files/file_missing/content')
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('FILE_NOT_FOUND')

    context.database.prepare(`UPDATE files SET status = 'DELETED' WHERE id = ?`).run(fileId)
    const deleted = await request(context.app).get(`/api/files/${fileId}/content`)
    expect(deleted.status).toBe(404)
    expect(deleted.body.error.code).toBe('FILE_NOT_FOUND')
    expect(deleted.headers['content-type']).not.toMatch(/application\/pdf/)

    const escapedId = 'file_escaped'
    context.database.prepare(`
      INSERT INTO files (id, file_name, file_type, file_size, storage_path, status)
      VALUES (?, 'secret.pdf', 'application/pdf', ?, ?, 'COMPLETED')
    `).run(escapedId, outsidePdf.length, relative(resolve(process.cwd()), outsidePath).replaceAll('\\', '/'))
    const escaped = await request(context.app).get(`/api/files/${escapedId}/content`).buffer(true).parse(readBinary)
    expect(escaped.status).toBe(404)
    expect(escaped.body.error?.code ?? escaped.body.toString()).not.toContain('secret outside')
  })

  it('returns saved key points and citations without calling a model', async () => {
    const context = await createDetailContext()
    const fileId = 'file_summary_detail'
    context.database.prepare(`
      INSERT INTO files (id, file_name, file_type, file_size, storage_path, status)
      VALUES (?, 'summary.pdf', 'application/pdf', 20, 'uploads/summary.pdf', 'COMPLETED')
    `).run(fileId)
    insertTestTask(context.database, 'task_summary_detail', fileId, 'req_summary_detail')
    context.summaryRepository.create({
      id: 'summary_detail',
      fileId,
      taskId: 'task_summary_detail',
      content: '全文说明 alpha。',
      keyPoints: [{ content: 'alpha', sourceChunkIndexes: [0] }],
      citations: [{ chunkId: 'chunk_1', pageNumber: 1, quote: 'alpha' }],
      modelName: 'test-model',
      promptVersion: 'summary-v2',
      inputTokens: 12,
      outputTokens: 8,
    })

    const response = await request(context.app).get(`/api/files/${fileId}`)

    expect(response.status).toBe(200)
    expect(Object.keys(response.body.data).sort()).toEqual(['file', 'summary', 'task'])
    expect(response.body.data.summary).toMatchObject({
      content: '全文说明 alpha。',
      keyPoints: [{ content: 'alpha', sourceChunkIndexes: [0] }],
      citations: [{ chunkId: 'chunk_1', pageNumber: 1, quote: 'alpha' }],
    })
  })

  it('hides document text for a missing or deleted file', async () => {
    const context = await createDetailContext()
    const missing = await request(context.app).get('/api/files/file_missing/document-text')
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('FILE_NOT_FOUND')

    const fileId = 'file_deleted_text'
    context.database.prepare(`
      INSERT INTO files (id, file_name, file_type, file_size, storage_path, status)
      VALUES (?, 'deleted.pdf', 'application/pdf', 20, 'uploads/deleted.pdf', 'DELETED')
    `).run(fileId)
    context.documentTextRepository.create({ id: 'page_deleted', fileId, pageNumber: 1, content: 'hidden page' })
    const deleted = await request(context.app).get(`/api/files/${fileId}/document-text`)
    expect(deleted.status).toBe(404)
    expect(deleted.body.error.code).toBe('FILE_NOT_FOUND')
    expect(JSON.stringify(deleted.body)).not.toContain('hidden page')
  })
})
