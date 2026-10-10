import { logger } from '../core/logger.js'
import type { Task } from '../models/task.js'
import { TaskRepository } from '../repositories/task-repository.js'
import { OperationLogger } from './operation-logger.js'

const DEFAULT_POLL_INTERVAL_MS = 1000
const QUEUED_BATCH_SIZE = 20
export const PDF_PARSER_NOT_CONNECTED_MESSAGE = 'PDF 解析尚未接入'
export const TASK_INTERRUPTED_ON_RESTART_MESSAGE = '任务在进程重启时中断'

export type TaskExecutorDependencies = {
  taskRepository?: TaskRepository
  operationLogger?: OperationLogger
  pollIntervalMs?: number
}

export class TaskExecutor {
  private readonly taskRepository: TaskRepository
  private readonly operationLogger: OperationLogger
  private readonly pollIntervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  constructor(dependencies: TaskExecutorDependencies = {}) {
    this.taskRepository = dependencies.taskRepository ?? new TaskRepository()
    this.operationLogger = dependencies.operationLogger ?? new OperationLogger()
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
      this.processAvailableTasks()
    }, this.pollIntervalMs)
    if (!timer) {
      throw new Error('Task executor failed to start')
    }
    this.timer = timer
    this.processAvailableTasks()
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

  processAvailableTasks(): void {
    if (this.ticking) return
    this.ticking = true
    try {
      const ids = this.taskRepository.listIdsByStatus('QUEUED', QUEUED_BATCH_SIZE)
      for (const id of ids) {
        const changes = this.taskRepository.claimQueued(id)
        if (changes !== 1) continue
        const task = this.taskRepository.findById(id)
        if (!task) continue
        this.failBecauseParserIsNotConnected(task)
      }
    } catch (error: unknown) {
      logger.error('TASK_EXECUTOR_TICK_FAILED', { errorCode: 'TASK_EXECUTION_FAILED' })
      console.error(error)
    } finally {
      this.ticking = false
    }
  }

  private failBecauseParserIsNotConnected(task: Task): void {
    const changes = this.taskRepository.markFailed(
      task.id,
      'RUNNING',
      'TASK_EXECUTION_FAILED',
      PDF_PARSER_NOT_CONNECTED_MESSAGE,
    )
    if (changes !== 1) return
    this.recordTaskFailed(task, PDF_PARSER_NOT_CONNECTED_MESSAGE)
  }

  private recordTaskFailed(task: Task, errorMessage: string): void {
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
      errorCode: 'TASK_EXECUTION_FAILED',
    })
  }
}
