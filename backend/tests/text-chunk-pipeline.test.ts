import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChunkSourcePage, TextChunkDraft } from '../app/services/chunk/text-chunker.js'
import { DocumentTextRepository } from '../app/repositories/document-text-repository.js'
import { FileRepository } from '../app/repositories/file-repository.js'
import { OperationLogRepository } from '../app/repositories/operation-log-repository.js'
import { TaskRepository } from '../app/repositories/task-repository.js'
import { TextChunkRepository } from '../app/repositories/text-chunk-repository.js'
import { OperationLogger } from '../app/services/operation-logger.js'
import { TaskExecutor } from '../app/services/task-executor.js'
import { closeRepositoryTestDatabase, openRepositoryTestDatabase } from './repository-test-helper.js'
import { createTextPdf } from './pdf-fixture.js'
import { createTracingLlmClient } from './tracing-llm-client.js'

let databaseDirectory = ''
let uploadDirectory = ''
let executor: TaskExecutor | undefined

afterEach(async () => {
  executor?.stop()
  executor = undefined
  if (databaseDirectory) {
    await closeRepositoryTestDatabase(databaseDirectory)
    databaseDirectory = ''
  }
  if (uploadDirectory) {
    await rm(uploadDirectory, { recursive: true, force: true })
    uploadDirectory = ''
  }
})

async function createPipeline(chunkDocumentTexts?: (pages: readonly ChunkSourcePage[]) => TextChunkDraft[]) {
  const databaseContext = await openRepositoryTestDatabase()
  databaseDirectory = databaseContext.directory
  uploadDirectory = await mkdtemp(join(tmpdir(), 'xiaodou-chunks-'))
  const fileRepository = new FileRepository(databaseContext.database)
  const taskRepository = new TaskRepository(databaseContext.database)
  const documentTextRepository = new DocumentTextRepository(databaseContext.database)
  const textChunkRepository = new TextChunkRepository(databaseContext.database)
  const operationLogger = new OperationLogger(new OperationLogRepository(databaseContext.database))
  executor = new TaskExecutor({
    taskRepository,
    fileRepository,
    documentTextRepository,
    textChunkRepository,
    operationLogger,
    chunkDocumentTexts,
    llmClient: createTracingLlmClient(),
    pollIntervalMs: 1000,
  })
  return { database: databaseContext.database, fileRepository, taskRepository, documentTextRepository, textChunkRepository }
}

describe('text chunk pipeline', () => {
  it('writes one document text per page and continuous chunks for a three-page PDF', async () => {
    const context = await createPipeline()
    const fileId = 'file_three_pages'
    const pdf = createTextPdf(['alpha page one', 'beta page two', 'gamma page three'])
    const absolutePath = join(uploadDirectory, `${fileId}.pdf`)
    await writeFile(absolutePath, pdf)
    const storagePath = relative(resolve(process.cwd()), absolutePath).replaceAll('\\', '/')
    context.database.prepare(`
      INSERT INTO files (id, file_name, file_type, file_size, storage_path, status)
      VALUES (?, ?, 'application/pdf', ?, ?, 'UPLOADED')
    `).run(fileId, 'three.pdf', pdf.length, storagePath)
    context.taskRepository.create({ id: 'task_three_pages', fileId, requestId: 'req_three_pages' })

    await executor?.processAvailableTasks()

    const texts = context.documentTextRepository.findByFileId(fileId)
    expect(texts).toHaveLength(3)
    expect(texts.map((text) => text.pageNumber)).toEqual([1, 2, 3])
    expect(texts.map((text) => text.content)).toEqual(['alpha page one', 'beta page two', 'gamma page three'])

    const chunks = context.textChunkRepository.findByFileId(fileId)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_, index) => index))
    expect(chunks.map((chunk) => chunk.pageNumber)).toEqual([1, 2, 3])
    expect(chunks.every((chunk) => chunk.content.trim().length > 0)).toBe(true)
    expect(chunks.every((chunk) => chunk.embeddingStatus === 'NOT_READY')).toBe(true)
    expect(context.fileRepository.findById(fileId)?.status).toBe('COMPLETED')
    expect(context.database.prepare('SELECT COUNT(*) AS count FROM summaries').get()).toEqual({ count: 1 })

    const task = context.taskRepository.findById('task_three_pages')
    expect(task).toMatchObject({
      status: 'SUCCEEDED',
      currentStep: 'COMPLETED',
      progress: 100,
      errorCode: null,
      errorMessage: null,
    })
  })

  it('replaces chunks when the same file is processed again', async () => {
    const context = await createPipeline()
    const fileId = 'file_repeat'
    const pdf = createTextPdf(['repeat-me'])
    const absolutePath = join(uploadDirectory, `${fileId}.pdf`)
    await writeFile(absolutePath, pdf)
    const storagePath = relative(resolve(process.cwd()), absolutePath).replaceAll('\\', '/')
    context.database.prepare(`
      INSERT INTO files (id, file_name, file_type, file_size, storage_path, status)
      VALUES (?, ?, 'application/pdf', ?, ?, 'UPLOADED')
    `).run(fileId, 'repeat.pdf', pdf.length, storagePath)
    context.taskRepository.create({ id: 'task_repeat', fileId, requestId: 'req_repeat' })

    await executor?.processAvailableTasks()
    const first = context.textChunkRepository.findByFileId(fileId)
    expect(first).toHaveLength(1)

    context.database.prepare(`
      UPDATE tasks
      SET status = 'QUEUED', finished_at = NULL, error_code = NULL, error_message = NULL
      WHERE id = 'task_repeat'
    `).run()
    await executor?.processAvailableTasks()

    const second = context.textChunkRepository.findByFileId(fileId)
    expect(second).toHaveLength(first.length)
    expect(second.map((chunk) => chunk.chunkIndex)).toEqual([0])
    expect(second.map((chunk) => chunk.content)).toEqual(first.map((chunk) => chunk.content))
    expect(context.documentTextRepository.findByFileId(fileId)).toHaveLength(1)
    expect(context.database.prepare('SELECT COUNT(*) AS count FROM text_chunks WHERE file_id = ?').get(fileId)).toEqual({ count: 1 })
  })

  it('fails the running task when chunking throws and does not store a stack', async () => {
    const context = await createPipeline(() => {
      throw new Error('chunk boom\n    at secret-chunker.ts:12:4')
    })
    const fileId = 'file_chunk_fail'
    const pdf = createTextPdf(['page one', 'page two', 'page three'])
    const absolutePath = join(uploadDirectory, `${fileId}.pdf`)
    await writeFile(absolutePath, pdf)
    const storagePath = relative(resolve(process.cwd()), absolutePath).replaceAll('\\', '/')
    context.database.prepare(`
      INSERT INTO files (id, file_name, file_type, file_size, storage_path, status)
      VALUES (?, ?, 'application/pdf', ?, ?, 'UPLOADED')
    `).run(fileId, 'fail.pdf', pdf.length, storagePath)
    context.taskRepository.create({ id: 'task_chunk_fail', fileId, requestId: 'req_chunk_fail' })

    await executor?.processAvailableTasks()

    const task = context.taskRepository.findById('task_chunk_fail')
    expect(task).toMatchObject({
      status: 'FAILED',
      currentStep: 'CREATE_CHUNKS',
      errorCode: 'TASK_EXECUTION_FAILED',
      errorMessage: '文本分块失败',
    })
    expect(task?.errorMessage).not.toContain('secret-chunker')
    expect(task?.errorMessage).not.toContain('\n')
    expect(context.documentTextRepository.findByFileId(fileId)).toHaveLength(3)
    expect(context.textChunkRepository.findByFileId(fileId)).toEqual([])
    expect(context.database.prepare('SELECT COUNT(*) AS count FROM summaries').get()).toEqual({ count: 0 })
  })
})
