import { randomUUID } from 'node:crypto'
import { ApplicationError } from '../core/errors/application-error.js'
import type { Task } from '../models/task.js'
import { SummaryRepository } from '../repositories/summary-repository.js'
import { SummaryAgent, type SummaryChunkInput, type SummaryDraft } from './agent/summary-agent.js'
import { selectSummaryContext } from './summary/context-selector.js'
import type { LlmClient } from './llm/llm-client.js'
import { OperationLogger } from './operation-logger.js'

export function preserveSummaryContent(content: string): string {
  const unwrapped = unwrapOuterFence(content.trim())
  return unwrapped.replace(/\n{3,}/g, '\n\n').trim()
}

function unwrapOuterFence(content: string): string {
  const fenced = content.match(/^```(?:markdown|md)?[^\n]*\n([\s\S]*?)\n?```$/i)
  return fenced?.[1] ?? content
}

export type SummaryServiceDependencies = {
  agent?: SummaryAgent
  llmClient?: LlmClient
  summaryRepository?: SummaryRepository
  operationLogger?: OperationLogger
}

export class SummaryService {
  private readonly agent: SummaryAgent
  private readonly summaryRepository: SummaryRepository
  private readonly operationLogger: OperationLogger

  constructor(dependencies: SummaryServiceDependencies = {}) {
    if (!dependencies.agent && !dependencies.llmClient) {
      throw new Error('SummaryService requires an agent or an LLM client')
    }
    this.agent = dependencies.agent ?? new SummaryAgent(dependencies.llmClient as LlmClient)
    this.summaryRepository = dependencies.summaryRepository ?? new SummaryRepository()
    this.operationLogger = dependencies.operationLogger ?? new OperationLogger()
  }

  async generate(task: Task, chunks: readonly SummaryChunkInput[]): Promise<SummaryDraft> {
    this.operationLogger.log({
      requestId: task.requestId,
      fileId: task.fileId,
      taskId: task.id,
      operation: 'SUMMARY_STARTED',
      status: 'STARTED',
    })
    const selectedChunks = selectSummaryContext(chunks)
    if (selectedChunks.length === 0) {
      throw new ApplicationError('SUMMARY_GENERATION_FAILED', {
        message: '没有可摘要的文本',
        fileId: task.fileId,
        taskId: task.id,
      })
    }

    this.operationLogger.log({
      requestId: task.requestId,
      fileId: task.fileId,
      taskId: task.id,
      operation: 'LLM_REQUEST_STARTED',
      status: 'STARTED',
    })
    try {
      const draft = await this.agent.summarize(selectedChunks)
      this.operationLogger.log({
        requestId: task.requestId,
        fileId: task.fileId,
        taskId: task.id,
        operation: 'LLM_REQUEST_COMPLETED',
        status: 'SUCCEEDED',
      })
      return draft
    } catch (error: unknown) {
      const applicationError = error instanceof ApplicationError
        ? error
        : new ApplicationError('SUMMARY_GENERATION_FAILED', { fileId: task.fileId, taskId: task.id, cause: error })
      this.operationLogger.log({
        requestId: task.requestId,
        fileId: task.fileId,
        taskId: task.id,
        operation: 'LLM_REQUEST_FAILED',
        status: 'FAILED',
        errorMessage: applicationError.message,
      })
      throw applicationError
    }
  }

  save(task: Task, draft: SummaryDraft) {
    try {
      const summary = this.summaryRepository.replaceForTask({
        id: randomUUID(),
        fileId: task.fileId,
        taskId: task.id,
        content: preserveSummaryContent(draft.summary),
        keyPoints: draft.keyPoints,
        citations: draft.citations,
        modelName: draft.modelName,
        promptVersion: draft.promptVersion,
        inputTokens: draft.inputTokens,
        outputTokens: draft.outputTokens,
      })
      this.operationLogger.log({
        requestId: task.requestId,
        fileId: task.fileId,
        taskId: task.id,
        operation: 'SUMMARY_SAVED',
        status: 'SUCCEEDED',
      })
      return summary
    } catch (error: unknown) {
      if (error instanceof ApplicationError) throw error
      throw new ApplicationError('TASK_EXECUTION_FAILED', {
        message: '摘要保存失败',
        fileId: task.fileId,
        taskId: task.id,
        cause: error,
      })
    }
  }
}
