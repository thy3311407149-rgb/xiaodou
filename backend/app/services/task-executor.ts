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
import { chunkDocumentTexts, type ChunkSourcePage } from './chunk/text-chunker.js'
import { HttpLlmClient, type LlmClient } from './llm/llm-client.js'
import { OperationLogger } from './operation-logger.js'
import { SummaryService } from './summary-service.js'
import { NoteTaskHandler } from './task/note-task-handler.js'
import { PdfTaskHandler } from './task/pdf-task-handler.js'
import { RecordingTaskHandler } from './task/recording-task-handler.js'
import { TaskHandlerRegistry } from './task/task-handler-registry.js'
import type { TaskHandler } from './task/task-handler.js'

const DEFAULT_POLL_INTERVAL_MS = 1000
const QUEUED_BATCH_SIZE = 20
const COMPLETED_PROGRESS = 100
export const TASK_INTERRUPTED_ON_RESTART_MESSAGE = '任务在进程重启时中断'

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
  handlers?: readonly TaskHandler[]
  pollIntervalMs?: number
}

export class TaskExecutor {
  private readonly taskRepository: TaskRepository
  private readonly fileRepository: FileRepository
  private readonly operationLogger: OperationLogger
  private readonly registry: TaskHandlerRegistry
  private readonly pollIntervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  constructor(dependencies: TaskExecutorDependencies = {}) {
    this.taskRepository = dependencies.taskRepository ?? new TaskRepository()
    this.fileRepository = dependencies.fileRepository ?? new FileRepository()
    const documentTextRepository = dependencies.documentTextRepository ?? new DocumentTextRepository()
    const textChunkRepository = dependencies.textChunkRepository ?? new TextChunkRepository()
    this.operationLogger = dependencies.operationLogger ?? new OperationLogger()
    const summaryService = dependencies.summaryService ?? new SummaryService({
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
    this.registry = new TaskHandlerRegistry(dependencies.handlers ?? [
      new PdfTaskHandler({
        taskRepository: this.taskRepository,
        fileRepository: this.fileRepository,
        documentTextRepository,
        textChunkRepository,
        summaryService,
        operationLogger: this.operationLogger,
        extractPdfPages: dependencies.extractPdfPages,
        chunkDocumentTexts: dependencies.chunkDocumentTexts,
      }),
      new RecordingTaskHandler({
        taskRepository: this.taskRepository,
        summaryRepository: dependencies.summaryRepository,
        summaryService,
      }),
      new NoteTaskHandler(),
    ])
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
      const result = await this.registry.resolve(task.taskType).execute(task)
      if (!result.finished) return
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
        fileId: task.fileId ?? undefined,
        taskId: task.id,
        operation: 'TASK_COMPLETED',
        status: 'SUCCEEDED',
      })
    } catch (error: unknown) {
      this.failTask(task, error)
    }
  }

  private failTask(task: Task, error: unknown): void {
    const applicationError = error instanceof ApplicationError
      ? error
      : new ApplicationError('TASK_EXECUTION_FAILED', { fileId: task.fileId ?? undefined, taskId: task.id, cause: error })
    if (task.taskType === 'PROCESS_PDF' && task.fileId) {
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
    }
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
      fileId: task.fileId ?? undefined,
      taskId: task.id,
      operation: 'TASK_FAILED',
      status: 'FAILED',
      errorCode,
    })
  }
}
