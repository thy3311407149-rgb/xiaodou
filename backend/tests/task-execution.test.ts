import express from 'express'
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app/app.js'
import { createFileRouter } from '../app/api/files.js'
import { createTaskRouter } from '../app/api/tasks.js'
import { errorHandler } from '../app/core/errors/error-handler.js'
import { requestIdMiddleware } from '../app/core/request-id-middleware.js'
import { requestLoggingMiddleware } from '../app/core/request-logging-middleware.js'
import { FileRepository } from '../app/repositories/file-repository.js'
import { OperationLogRepository } from '../app/repositories/operation-log-repository.js'
import { TaskRepository } from '../app/repositories/task-repository.js'
import { FileService } from '../app/services/file-service.js'
import { OperationLogger } from '../app/services/operation-logger.js'
import { TaskExecutor } from '../app/services/task-executor.js'
import { closeRepositoryTestDatabase, insertTestFile, openRepositoryTestDatabase } from './repository-test-helper.js'

const fixturePath = resolve('tests/fixtures/minimal.pdf')
let databaseDirectory = ''
let uploadDirectory = ''
let executor: TaskExecutor | undefined

afterEach(async () => {
  executor?.stop()
  executor = undefined
  vi.restoreAllMocks()
  if (databaseDirectory) {
    await closeRepositoryTestDatabase(databaseDirectory)
    databaseDirectory = ''
  }
  if (uploadDirectory) {
    await rm(uploadDirectory, { recursive: true, force: true })
    uploadDirectory = ''
  }
})

function tableCount(database: Database.Database, table: 'summaries' | 'document_texts' | 'text_chunks' | 'files' | 'tasks'): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
  return row.count
}

async function createTestContext() {
  const databaseContext = await openRepositoryTestDatabase()
  databaseDirectory = databaseContext.directory
  uploadDirectory = await mkdtemp(join(tmpdir(), 'xiaodou-task-uploads-'))
  const fileRepository = new FileRepository(databaseContext.database)
  const taskRepository = new TaskRepository(databaseContext.database)
  const operationLogRepository = new OperationLogRepository(databaseContext.database)
  const operationLogger = new OperationLogger(operationLogRepository)
  const service = new FileService({
    database: databaseContext.database,
    fileRepository,
    taskRepository,
    operationLogger,
    uploadDir: uploadDirectory,
  })
  const app = express()
  app.use(express.json())
  app.use(requestIdMiddleware)
  app.use(requestLoggingMiddleware)
  app.use(createFileRouter({ fileService: service, uploadDir: uploadDirectory, maxFileSizeBytes: 1024 }))
  app.use(createTaskRouter({ taskRepository }))
  app.use(errorHandler)
  executor = new TaskExecutor({ taskRepository, operationLogger, pollIntervalMs: 20 })
  return { app, database: databaseContext.database, fileRepository, taskRepository, operationLogRepository, operationLogger, service }
}

describe('Phase 8.1 task execution', () => {
  it('creates a real QUEUED task when a PDF upload succeeds', async () => {
    const context = await createTestContext()
    const uploadResponse = await request(context.app)
      .post('/api/files')
      .set('X-Request-Id', 'req_task_upload_001')
      .attach('file', fixturePath, { filename: 'sample.pdf', contentType: 'application/pdf' })

    expect(uploadResponse.status).toBe(201)
    const fileId = uploadResponse.body.data.file.id as string
    const taskId = uploadResponse.body.data.task.id as string
    expect(uploadResponse.body.data.file.status).toBe('UPLOADED')
    expect(uploadResponse.body.data.task).toEqual({
      id: taskId,
      fileId,
      taskType: 'PROCESS_PDF',
      status: 'QUEUED',
      currentStep: 'EXTRACT_TEXT',
      progress: 0,
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      finishedAt: null,
    })
    expect(context.fileRepository.findById(fileId)?.status).toBe('UPLOADED')
    expect(context.taskRepository.findById(taskId)).toMatchObject({
      fileId,
      taskType: 'PROCESS_PDF',
      status: 'QUEUED',
      currentStep: 'EXTRACT_TEXT',
      progress: 0,
      requestId: 'req_task_upload_001',
      retryCount: 0,
    })

    const taskResponse = await request(context.app).get(`/api/tasks/${taskId}`).set('X-Request-Id', 'req_task_get_001')
    expect(taskResponse.status).toBe(200)
    expect(taskResponse.headers['x-request-id']).toBe('req_task_get_001')
    expect(taskResponse.body).toEqual({
      requestId: 'req_task_get_001',
      data: { task: uploadResponse.body.data.task },
    })

    const detailResponse = await request(context.app).get(`/api/files/${fileId}`)
    expect(detailResponse.body.data.task.id).toBe(taskId)
    expect(detailResponse.body.data.summary).toBeNull()
    expect(context.operationLogRepository.listByTaskId(taskId).map((log) => log.operation)).toContain('TASK_CREATED')
  })

  it('returns a standardized not found error for an unknown task', async () => {
    const context = await createTestContext()
    const response = await request(context.app).get('/api/tasks/task_missing').set('X-Request-Id', 'req_task_missing')

    expect(response.status).toBe(404)
    expect(response.body).toEqual({
      error: {
        code: 'TASK_NOT_FOUND',
        message: '任务不存在',
        requestId: 'req_task_missing',
        taskId: 'task_missing',
      },
    })
    expect(response.body.data).toBeUndefined()
  })

  it('returns null task details when a file has no task', async () => {
    const context = await createTestContext()
    insertTestFile(context.database, 'file_without_task')
    context.database.prepare("UPDATE files SET status = 'UPLOADED' WHERE id = ?").run('file_without_task')

    const response = await request(context.app).get('/api/files/file_without_task')
    expect(response.status).toBe(200)
    expect(response.body.data.file.id).toBe('file_without_task')
    expect(response.body.data.task).toBeNull()
    expect(response.body.data.summary).toBeNull()
  })

  it('returns 409 when the active-task unique index rejects task creation', async () => {
    const context = await createTestContext()
    const originalCreate = context.taskRepository.create.bind(context.taskRepository)
    vi.spyOn(context.taskRepository, 'create').mockImplementation((input) => {
      originalCreate(input)
      return originalCreate({ ...input, id: randomUUID() })
    })

    const response = await request(context.app)
      .post('/api/files')
      .set('X-Request-Id', 'req_task_conflict')
      .attach('file', fixturePath, { filename: 'conflict.pdf', contentType: 'application/pdf' })

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('TASK_ALREADY_RUNNING')
    expect(response.body.error.requestId).toBe('req_task_conflict')
    expect(tableCount(context.database, 'files')).toBe(0)
    expect(tableCount(context.database, 'tasks')).toBe(0)
    const remainingFiles = await readdir(uploadDirectory, { recursive: true })
    expect(remainingFiles.filter((name) => String(name).endsWith('.pdf'))).toEqual([])
  })

  it('claims a QUEUED task only once', async () => {
    const context = await createTestContext()
    insertTestFile(context.database, 'file_claim')
    context.taskRepository.create({ id: 'task_claim', fileId: 'file_claim', requestId: 'req_claim', retryCount: 1 })

    expect(context.taskRepository.claimQueued('task_missing')).toBe(0)
    expect(context.taskRepository.claimQueued('task_claim')).toBe(1)
    expect(context.taskRepository.claimQueued('task_claim')).not.toBe(1)
    expect(context.taskRepository.findById('task_claim')).toMatchObject({
      status: 'RUNNING',
      retryCount: 1,
      currentStep: 'EXTRACT_TEXT',
      progress: 0,
    })
    expect(context.taskRepository.findById('task_claim')?.startedAt).toEqual(expect.any(String))
  })

  it('fails summary generation for an empty PDF and does not write a summary', async () => {
    const context = await createTestContext()
    const uploadResponse = await request(context.app)
      .post('/api/files')
      .set('X-Request-Id', 'req_task_fail_001')
      .attach('file', fixturePath, { filename: 'pending.pdf', contentType: 'application/pdf' })
    const fileId = uploadResponse.body.data.file.id as string
    const taskId = uploadResponse.body.data.task.id as string

    await executor?.processAvailableTasks()
    await executor?.processAvailableTasks()

    const task = context.taskRepository.findById(taskId)
    expect(task).toMatchObject({
      status: 'FAILED',
      currentStep: 'GENERATE_SUMMARY',
      progress: 70,
      errorCode: 'SUMMARY_GENERATION_FAILED',
      errorMessage: '没有可摘要的文本',
      retryCount: 0,
    })
    expect(task?.startedAt).toEqual(expect.any(String))
    expect(task?.finishedAt).toEqual(expect.any(String))
    expect(task?.errorMessage).not.toContain('at ')
    expect(context.fileRepository.findById(fileId)?.status).toBe('SUMMARY_FAILED')
    expect(tableCount(context.database, 'summaries')).toBe(0)
    expect(tableCount(context.database, 'text_chunks')).toBe(0)

    const taskResponse = await request(context.app).get(`/api/tasks/${taskId}`)
    expect(taskResponse.status).toBe(200)
    expect(taskResponse.body.data.task).toMatchObject({
      id: taskId,
      status: 'FAILED',
      currentStep: 'GENERATE_SUMMARY',
      errorCode: 'SUMMARY_GENERATION_FAILED',
      errorMessage: '没有可摘要的文本',
    })
    const detailResponse = await request(context.app).get(`/api/files/${fileId}`)
    expect(detailResponse.body.data.summary).toBeNull()

    const logs = context.operationLogRepository.listByTaskId(taskId)
    expect(logs.map((log) => log.operation)).toEqual(expect.arrayContaining(['TASK_CREATED', 'TASK_FAILED']))
    expect(logs.some((log) => log.operation === 'TASK_COMPLETED')).toBe(false)
  })

  it('marks an interrupted RUNNING task as failed and then claims a leftover QUEUED task', async () => {
    const context = await createTestContext()
    insertTestFile(context.database, 'file_running')
    insertTestFile(context.database, 'file_queued')
    context.taskRepository.create({ id: 'task_running', fileId: 'file_running', requestId: 'req_running', retryCount: 2 })
    expect(context.taskRepository.claimQueued('task_running')).toBe(1)
    const before = context.taskRepository.findById('task_running')
    context.taskRepository.create({ id: 'task_queued', fileId: 'file_queued', requestId: 'req_queued', retryCount: 0 })

    expect(executor?.recoverInterruptedTasks()).toBe(1)

    const interrupted = context.taskRepository.findById('task_running')
    expect(interrupted).toMatchObject({
      id: before?.id,
      requestId: before?.requestId,
      createdAt: before?.createdAt,
      retryCount: 2,
      status: 'FAILED',
      errorCode: 'TASK_EXECUTION_FAILED',
      errorMessage: '任务在进程重启时中断',
      currentStep: 'EXTRACT_TEXT',
    })
    expect(context.taskRepository.listByFileId('file_running')).toHaveLength(1)
    expect(context.taskRepository.findById('task_queued')?.status).toBe('QUEUED')

    await executor?.processAvailableTasks()

    expect(context.taskRepository.findById('task_running')?.errorMessage).toBe('任务在进程重启时中断')
    expect(context.taskRepository.findById('task_queued')).toMatchObject({
      id: 'task_queued',
      status: 'FAILED',
      errorCode: 'PDF_EXTRACTION_FAILED',
      errorMessage: 'PDF 文本提取失败',
      retryCount: 0,
    })
    expect(context.operationLogRepository.listByTaskId('task_running')).toEqual([
      expect.objectContaining({ operation: 'TASK_FAILED', errorMessage: '任务在进程重启时中断', requestId: 'req_running' }),
    ])
  })

  it('returns a stored SUCCEEDED task unchanged', async () => {
    const context = await createTestContext()
    insertTestFile(context.database)
    context.taskRepository.create({ id: 'task_done', fileId: 'file_001', requestId: 'req_done' })
    context.taskRepository.update('task_done', { status: 'SUCCEEDED', currentStep: 'COMPLETED', progress: 100 })

    const response = await request(context.app).get('/api/tasks/task_done')
    expect(response.status).toBe(200)
    expect(response.body.data.task).toMatchObject({
      id: 'task_done',
      status: 'SUCCEEDED',
      currentStep: 'COMPLETED',
      progress: 100,
    })
  })

  it('clears the poll timer on stop', async () => {
    const context = await createTestContext()
    insertTestFile(context.database, 'file_timer')
    executor?.start()
    expect(executor?.isRunning()).toBe(true)
    executor?.stop()
    expect(executor?.isRunning()).toBe(false)

    context.taskRepository.create({ id: 'task_after_stop', fileId: 'file_timer', requestId: 'req_after_stop' })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 80))
    expect(context.taskRepository.findById('task_after_stop')?.status).toBe('QUEUED')
    executor?.stop()
  })

  it('polls a queued task after start', async () => {
    const context = await createTestContext()
    insertTestFile(context.database, 'file_poll')
    executor?.start()
    context.taskRepository.create({ id: 'task_poll', fileId: 'file_poll', requestId: 'req_poll' })

    const deadline = Date.now() + 1000
    while (context.taskRepository.findById('task_poll')?.status !== 'FAILED') {
      if (Date.now() > deadline) break
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    }

    expect(context.taskRepository.findById('task_poll')).toMatchObject({
      status: 'FAILED',
      errorCode: 'PDF_EXTRACTION_FAILED',
      errorMessage: 'PDF 文本提取失败',
    })
    executor?.stop()
  })

  it('keeps /health responsive while the executor is running', async () => {
    const context = await createTestContext()
    executor?.start()
    const response = await request(createApp()).get('/health')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ status: 'ok' })
    expect(executor?.isRunning()).toBe(true)
    executor?.stop()
    expect(context.database.open).toBe(true)
  })
})
