import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { config } from '../core/config.js'
import { ApplicationError } from '../core/errors/application-error.js'
import { logger } from '../core/logger.js'
import type { FileStatus } from '../models/file.js'
import type { Task } from '../models/task.js'
import { DocumentTextRepository } from '../repositories/document-text-repository.js'
import { FileRepository } from '../repositories/file-repository.js'
import { SummaryRepository } from '../repositories/summary-repository.js'
import { TaskRepository } from '../repositories/task-repository.js'
import { TextChunkRepository } from '../repositories/text-chunk-repository.js'
import type { SummaryChunkInput } from './agent/summary-agent.js'
import { chunkDocumentTexts, type ChunkSourcePage } from './chunk/text-chunker.js'
import { HttpLlmClient, type LlmClient } from './llm/llm-client.js'
import { OperationLogger } from './operation-logger.js'
import { cleanPdfText } from './pdf/pdf-text-cleaner.js'
import { extractPdfPages } from './pdf/pdf-text-extractor.js'
import { SummaryService } from './summary-service.js'

const DEFAULT_POLL_INTERVAL_MS = 1000
const QUEUED_BATCH_SIZE = 20
const EXTRACT_TEXT_PROGRESS = 10
const SAVE_DOCUMENT_TEXT_PROGRESS = 30
const CREATE_CHUNKS_PROGRESS = 50
const GENERATE_SUMMARY_PROGRESS = 70
const SAVE_SUMMARY_PROGRESS = 90
const COMPLETED_PROGRESS = 100
export const TASK_INTERRUPTED_ON_RESTART_MESSAGE = '任务在进程重启时中断'
const CHUNK_FAILED_MESSAGE = '文本分块失败'

export type TaskExecutorDependencies = {
  taskRepository?: TaskRepository
  fileRepository?: FileRepository
  documentTextRepository?: DocumentTextRepository
  textChunkRepository?: TextChunkRepository
  summaryRepository?: SummaryRepository
  summaryService?: SummaryService
  llmClient?: LlmClient
  operationLogger?: OperationLogger
  extractPdfPages?: (absolutePath: string) => Promise<ChunkSourcePage[]>
  chunkDocumentTexts?: (pages: readonly ChunkSourcePage[]) => ReturnType<typeof chunkDocumentTexts>
  pollIntervalMs?: number
}

export class TaskExecutor {
  private readonly taskRepository: TaskRepository
  private readonly fileRepository: FileRepository
  private readonly documentTextRepository: DocumentTextRepository
  private readonly textChunkRepository: TextChunkRepository
  private readonly summaryService: SummaryService
  private readonly operationLogger: OperationLogger
  private readonly extractPdfPages: (absolutePath: string) => Promise<ChunkSourcePage[]>
  private readonly chunkDocumentTexts: (pages: readonly ChunkSourcePage[]) => ReturnType<typeof chunkDocumentTexts>
  private readonly pollIntervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  constructor(dependencies: TaskExecutorDependencies = {}) {
    this.taskRepository = dependencies.taskRepository ?? new TaskRepository()
    this.fileRepository = dependencies.fileRepository ?? new FileRepository()
    this.documentTextRepository = dependencies.documentTextRepository ?? new DocumentTextRepository()
    this.textChunkRepository = dependencies.textChunkRepository ?? new TextChunkRepository()
    this.operationLogger = dependencies.operationLogger ?? new OperationLogger()
    this.summaryService = dependencies.summaryService ?? new SummaryService({
      llmClient: dependencies.llmClient ?? new HttpLlmClient({
        baseUrl: config.llmBaseUrl,
        apiKey: config.llmApiKey,
        model: config.llmModel,
        timeoutMs: config.llmTimeoutMs,
        maxRetries: config.llmMaxRetries,
        maxTokens: config.llmMaxOutputTokens,
        temperature: config.llmTemperature,
      }),
      summaryRepository: dependencies.summaryRepository ?? new SummaryRepository(),
      operationLogger: this.operationLogger,
    })
    this.extractPdfPages = dependencies.extractPdfPages ?? extractPdfPages
    this.chunkDocumentTexts = dependencies.chunkDocumentTexts ?? chunkDocumentTexts
    this.pollIntervalMs = dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  }

  recoverInterruptedTasks(): number {
    let recovered = 0
    for (;;) {
      const ids = this.taskRepository.listIdsByStatus('RUNNING', QUEUED_BATCH_SIZE)
      if (ids.length === 0) return recovered
      let recoveredThisPass = 0
      for (const id of ids) {
        const task = this.taskRepository.findById(id)
        if (!task || task.status !== 'RUNNING') continue
        const changes = this.taskRepository.markFailed(
          id,
          'RUNNING',
          'TASK_EXECUTION_FAILED',
          TASK_INTERRUPTED_ON_RESTART_MESSAGE,
        )
        if (changes !== 1) continue
        recovered += 1
        recoveredThisPass += 1
        this.recordTaskFailed(task, TASK_INTERRUPTED_ON_RESTART_MESSAGE)
      }
      if (recoveredThisPass === 0) return recovered
    }
  }

  start(): void {
    if (this.timer) return
    const timer = setInterval(() => {
      void this.processAvailableTasks()
    }, this.pollIntervalMs)
    if (!timer) {
      throw new Error('Task executor failed to start')
    }
    this.timer = timer
    void this.processAvailableTasks()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  isRunning(): boolean {
    return this.timer !== null
  }

  processAvailableTasks(): Promise<void> {
    if (this.ticking) return Promise.resolve()
    this.ticking = true
    return this.runTick().finally(() => {
      this.ticking = false
    })
  }

  private async runTick(): Promise<void> {
    try {
      const ids = this.taskRepository.listIdsByStatus('QUEUED', QUEUED_BATCH_SIZE)
      for (const id of ids) {
        const changes = this.taskRepository.claimQueued(id)
        if (changes !== 1) continue
        const task = this.taskRepository.findById(id)
        if (!task) continue
        await this.executeTask(task)
      }
    } catch (error: unknown) {
      logger.error('TASK_EXECUTOR_TICK_FAILED', { errorCode: 'TASK_EXECUTION_FAILED' })
      console.error(error)
    }
  }

  private async executeTask(task: Task): Promise<void> {
    try {
      this.markFile(task.fileId, 'EXTRACTING')
      if (this.taskRepository.updateRunning(task.id, 'EXTRACT_TEXT', EXTRACT_TEXT_PROGRESS) !== 1) return
      const pages = (await this.extractText(task)).map((page) => ({
        pageNumber: page.pageNumber,
        content: cleanPdfText(page.content),
      }))
      if (this.taskRepository.updateRunning(task.id, 'SAVE_DOCUMENT_TEXT', SAVE_DOCUMENT_TEXT_PROGRESS) !== 1) return
      this.saveDocumentTexts(task, pages)
      this.markFile(task.fileId, 'EXTRACTED')
      if (this.taskRepository.updateRunning(task.id, 'CREATE_CHUNKS', CREATE_CHUNKS_PROGRESS) !== 1) return
      this.saveChunks(task, pages)
      const chunks = this.toSummaryChunks(this.textChunkRepository.findByFileId(task.fileId))
      if (this.taskRepository.updateRunning(task.id, 'GENERATE_SUMMARY', GENERATE_SUMMARY_PROGRESS) !== 1) return
      this.markFile(task.fileId, 'SUMMARIZING')
      const draft = await this.summaryService.generate(task, chunks)
      if (this.taskRepository.updateRunning(task.id, 'SAVE_SUMMARY', SAVE_SUMMARY_PROGRESS) !== 1) return
      this.summaryService.save(task, draft)
      if (this.taskRepository.updateRunning(task.id, 'COMPLETED', COMPLETED_PROGRESS) !== 1) return
      this.markFile(task.fileId, 'COMPLETED')
      if (this.taskRepository.markSucceeded(task.id, 'COMPLETED', COMPLETED_PROGRESS) !== 1) return
      this.operationLogger.log({
        requestId: task.requestId,
        fileId: task.fileId,
        taskId: task.id,
        operation: 'TASK_COMPLETED',
        status: 'SUCCEEDED',
      })
      logger.info('TASK_COMPLETED', {
        requestId: task.requestId,
        fileId: task.fileId,
        taskId: task.id,
        operation: 'TASK_COMPLETED',
        status: 'SUCCEEDED',
      })
    } catch (error: unknown) {
      this.failTask(task, error)
    }
  }

  private async extractText(task: Task): Promise<ChunkSourcePage[]> {
    this.operationLogger.log({
      requestId: task.requestId,
      fileId: task.fileId,
      taskId: task.id,
      operation: 'PDF_EXTRACTION_STARTED',
      status: 'STARTED',
    })
    const file = this.fileRepository.findById(task.fileId)
    if (!file) {
      throw new ApplicationError('FILE_NOT_FOUND', { fileId: task.fileId, taskId: task.id })
    }

    try {
      const pages = await this.extractPdfPages(resolve(process.cwd(), file.storagePath))
      this.operationLogger.log({
        requestId: task.requestId,
        fileId: task.fileId,
        taskId: task.id,
        operation: 'PDF_EXTRACTION_COMPLETED',
        status: 'SUCCEEDED',
      })
      return pages
    } catch (error: unknown) {
      if (error instanceof ApplicationError) throw error
      this.operationLogger.log({
        requestId: task.requestId,
        fileId: task.fileId,
        taskId: task.id,
        operation: 'PDF_EXTRACTION_FAILED',
        status: 'FAILED',
        errorMessage: 'PDF 文本提取失败',
      })
      throw new ApplicationError('PDF_EXTRACTION_FAILED', { fileId: task.fileId, taskId: task.id, cause: error })
    }
  }

  private saveDocumentTexts(task: Task, pages: readonly ChunkSourcePage[]): void {
    try {
      this.documentTextRepository.replaceForFile(task.fileId, pages.map((page) => ({
        id: randomUUID(),
        fileId: task.fileId,
        pageNumber: page.pageNumber,
        content: page.content,
      })))
    } catch (error: unknown) {
      if (error instanceof ApplicationError) throw error
      throw new ApplicationError('TASK_EXECUTION_FAILED', {
        message: '文档文本保存失败',
        fileId: task.fileId,
        taskId: task.id,
        cause: error,
      })
    }
  }

  private saveChunks(task: Task, pages: readonly ChunkSourcePage[]): void {
    try {
      const drafts = this.chunkDocumentTexts(pages)
      this.textChunkRepository.createChunks(task.fileId, drafts.map((draft) => ({
        id: randomUUID(),
        fileId: task.fileId,
        pageNumber: draft.pageNumber,
        chunkIndex: draft.chunkIndex,
        content: draft.content,
        tokenCount: draft.tokenCount,
        embeddingStatus: 'NOT_READY',
      })))
    } catch (error: unknown) {
      if (error instanceof ApplicationError) throw error
      throw new ApplicationError('TASK_EXECUTION_FAILED', {
        message: CHUNK_FAILED_MESSAGE,
        fileId: task.fileId,
        taskId: task.id,
        cause: error,
      })
    }
  }

  private markFile(fileId: string, status: FileStatus): void {
    const updated = this.fileRepository.update(fileId, {
      status,
      errorCode: null,
      errorMessage: null,
      updatedAt: new Date().toISOString(),
    })
    if (!updated) throw new ApplicationError('FILE_NOT_FOUND', { fileId })
  }

  private toSummaryChunks(chunks: ReturnType<TextChunkRepository['findByFileId']>): SummaryChunkInput[] {
    return chunks.map((chunk) => ({
      chunkId: chunk.id,
      chunkIndex: chunk.chunkIndex,
      pageNumber: chunk.pageNumber,
      content: chunk.content,
    }))
  }

  private failTask(task: Task, error: unknown): void {
    const applicationError = error instanceof ApplicationError
      ? error
      : new ApplicationError('TASK_EXECUTION_FAILED', { fileId: task.fileId, taskId: task.id, cause: error })
    const step = this.taskRepository.findById(task.id)?.currentStep
    const fileStatus: FileStatus = step === 'GENERATE_SUMMARY' || step === 'SAVE_SUMMARY' || step === 'COMPLETED'
      ? 'SUMMARY_FAILED'
      : 'EXTRACTION_FAILED'
    this.fileRepository.update(task.fileId, {
      status: fileStatus,
      errorCode: applicationError.code,
      errorMessage: applicationError.message,
      updatedAt: new Date().toISOString(),
    })
    const changes = this.taskRepository.markFailed(task.id, 'RUNNING', applicationError.code, applicationError.message)
    if (changes !== 1) return
    this.recordTaskFailed(task, applicationError.message, applicationError.code)
  }

  private recordTaskFailed(task: Task, errorMessage: string, errorCode = 'TASK_EXECUTION_FAILED'): void {
    this.operationLogger.log({
      requestId: task.requestId,
      fileId: task.fileId,
      taskId: task.id,
      operation: 'TASK_FAILED',
      status: 'FAILED',
      errorMessage,
    })
    logger.info('TASK_FAILED', {
      requestId: task.requestId,
      fileId: task.fileId,
      taskId: task.id,
      operation: 'TASK_FAILED',
      status: 'FAILED',
      errorCode,
    })
  }
}
