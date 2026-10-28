import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApplicationError } from '../app/core/errors/application-error.js'
import { DocumentTextRepository } from '../app/repositories/document-text-repository.js'
import { FileRepository } from '../app/repositories/file-repository.js'
import { SummaryRepository } from '../app/repositories/summary-repository.js'
import { TaskRepository } from '../app/repositories/task-repository.js'
import { TextChunkRepository } from '../app/repositories/text-chunk-repository.js'
import type { LlmClient } from '../app/services/llm/llm-client.js'
import { OperationLogger } from '../app/services/operation-logger.js'
import { TaskExecutor } from '../app/services/task-executor.js'
import { OperationLogRepository } from '../app/repositories/operation-log-repository.js'
import { closeRepositoryTestDatabase, openRepositoryTestDatabase } from './repository-test-helper.js'
import { createTextPdf } from './pdf-fixture.js'
import { createTracingLlmClient } from './tracing-llm-client.js'

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

async function createSummaryContext(llmClient: LlmClient = createTracingLlmClient()) {
  const databaseContext = await openRepositoryTestDatabase()
  databaseDirectory = databaseContext.directory
  uploadDirectory = await mkdtemp(join(tmpdir(), 'xiaodou-summary-'))
  const fileRepository = new FileRepository(databaseContext.database)
  const taskRepository = new TaskRepository(databaseContext.database)
  const documentTextRepository = new DocumentTextRepository(databaseContext.database)
  const textChunkRepository = new TextChunkRepository(databaseContext.database)
  const summaryRepository = new SummaryRepository(databaseContext.database)
  const operationLogger = new OperationLogger(new OperationLogRepository(databaseContext.database))
  executor = new TaskExecutor({
    taskRepository,
    fileRepository,
    documentTextRepository,
    textChunkRepository,
    summaryRepository,
    operationLogger,
    llmClient,
    pollIntervalMs: 1000,
  })
  return { database: databaseContext.database, fileRepository, taskRepository, documentTextRepository, textChunkRepository, summaryRepository }
}

describe('summary pipeline', () => {
  it('summarizes text-3pages.pdf with traceable citations and one summary row', async () => {
    let modelPayload: { title?: string; summary?: string; keyPoints?: unknown; citations?: unknown } | undefined
    const tracingClient = createTracingLlmClient()
    const context = await createSummaryContext({
      async complete(messages) {
        const completion = await tracingClient.complete(messages)
        modelPayload = JSON.parse(completion.content) as { title?: string; summary?: string; keyPoints?: unknown; citations?: unknown }
        return completion
      },
    })
    const fileId = 'file_summary_pdf'
    const pdf = createTextPdf(['alpha page one', 'beta page two', 'gamma page three'])
    const absolutePath = join(uploadDirectory, 'text-3pages.pdf')
    await writeFile(absolutePath, pdf)
    const storagePath = relative(resolve(process.cwd()), absolutePath).replaceAll('\\', '/')
    context.database.prepare(`
      INSERT INTO files (id, file_name, file_type, file_size, storage_path, status)
      VALUES (?, 'text-3pages.pdf', 'application/pdf', ?, ?, 'UPLOADED')
    `).run(fileId, pdf.length, storagePath)
    context.taskRepository.create({ id: 'task_summary_pdf', fileId, requestId: 'req_summary_pdf' })
    const statuses: string[] = []
    const steps: string[] = []
    const originalUpdate = context.fileRepository.update.bind(context.fileRepository)
    const originalStep = context.taskRepository.updateRunning.bind(context.taskRepository)
    vi.spyOn(context.fileRepository, 'update').mockImplementation((id, input) => {
      if (input.status) statuses.push(input.status)
      return originalUpdate(id, input)
    })
    vi.spyOn(context.taskRepository, 'updateRunning').mockImplementation((id, step, progress) => {
      steps.push(`${step}:${progress}`)
      return originalStep(id, step, progress)
    })

    await executor?.processAvailableTasks()

    expect(context.documentTextRepository.findByFileId(fileId).length).toBeGreaterThan(0)
    const chunks = context.textChunkRepository.findByFileId(fileId)
    expect(chunks.length).toBeGreaterThan(0)
    const summaries = context.summaryRepository.listByFileId(fileId)
    expect(summaries).toHaveLength(1)
    const summary = summaries[0]
    expect(modelPayload?.title).toBe('文档摘要')
    expect(modelPayload?.summary).toEqual(expect.any(String))
    expect(modelPayload?.keyPoints).toEqual(expect.any(Array))
    expect(modelPayload?.citations).toEqual(expect.any(Array))
    expect(summary?.content.length).toBeGreaterThan(0)
    expect(summary?.keyPoints.length).toBeGreaterThan(0)
    expect(summary?.keyPoints[0]?.sourceChunkIndexes.length).toBeGreaterThan(0)
    expect(summary?.citations.length).toBeGreaterThan(0)
    expect(summary?.modelName).toBe('test-model')
    expect(summary?.promptVersion).toBe('summary-v5')
    expect(summary?.inputTokens).toBe(12)
    expect(summary?.outputTokens).toBe(8)

    const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]))
    for (const citation of summary?.citations ?? []) {
      const source = chunksById.get(citation.chunkId)
      expect(source).toBeTruthy()
      expect(citation.pageNumber).toBe(source?.pageNumber)
      expect(source?.content.includes(citation.quote)).toBe(true)
    }

    expect(context.fileRepository.findById(fileId)?.status).toBe('COMPLETED')
    expect(context.taskRepository.findById('task_summary_pdf')).toMatchObject({
      status: 'SUCCEEDED',
      currentStep: 'COMPLETED',
      progress: 100,
      errorCode: null,
      errorMessage: null,
    })
    expect(statuses).toEqual(['EXTRACTING', 'EXTRACTED', 'SUMMARIZING', 'COMPLETED'])
    expect(steps).toEqual([
      'EXTRACT_TEXT:10',
      'SAVE_DOCUMENT_TEXT:30',
      'CREATE_CHUNKS:50',
      'GENERATE_SUMMARY:70',
      'SAVE_SUMMARY:90',
      'COMPLETED:100',
    ])

    context.database.prepare(`
      UPDATE tasks
      SET status = 'QUEUED', finished_at = NULL, error_code = NULL, error_message = NULL
      WHERE id = 'task_summary_pdf'
    `).run()
    await executor?.processAvailableTasks()
    expect(context.summaryRepository.listByFileId(fileId)).toHaveLength(1)
    expect(context.database.prepare('SELECT COUNT(*) AS count FROM summaries WHERE task_id = ?').get('task_summary_pdf')).toEqual({ count: 1 })
  })

  it('fails the task when the LLM times out and does not write a summary', async () => {
    const context = await createSummaryContext({
      async complete() {
        throw new ApplicationError('LLM_TIMEOUT')
      },
    })
    const fileId = 'file_llm_timeout'
    const pdf = createTextPdf(['timeout page text'])
    const absolutePath = join(uploadDirectory, 'timeout.pdf')
    await writeFile(absolutePath, pdf)
    const storagePath = relative(resolve(process.cwd()), absolutePath).replaceAll('\\', '/')
    context.database.prepare(`
      INSERT INTO files (id, file_name, file_type, file_size, storage_path, status)
      VALUES (?, 'timeout.pdf', 'application/pdf', ?, ?, 'UPLOADED')
    `).run(fileId, pdf.length, storagePath)
    context.taskRepository.create({ id: 'task_llm_timeout', fileId, requestId: 'req_llm_timeout' })

    await executor?.processAvailableTasks()

    const task = context.taskRepository.findById('task_llm_timeout')
    expect(task).toMatchObject({
      status: 'FAILED',
      currentStep: 'GENERATE_SUMMARY',
      errorCode: 'LLM_TIMEOUT',
      errorMessage: 'AI 服务响应超时',
    })
    expect(task?.finishedAt).toEqual(expect.any(String))
    expect(task?.errorMessage).not.toContain('at ')
    expect(context.summaryRepository.listByFileId(fileId)).toEqual([])
    expect(context.fileRepository.findById(fileId)?.status).toBe('SUMMARY_FAILED')
    expect(context.documentTextRepository.findByFileId(fileId).length).toBeGreaterThan(0)
    expect(context.textChunkRepository.findByFileId(fileId).length).toBeGreaterThan(0)
  })
})
