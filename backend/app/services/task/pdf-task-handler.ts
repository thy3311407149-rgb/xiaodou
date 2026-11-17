import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { ApplicationError } from '../../core/errors/application-error.js'
import type { FileStatus } from '../../models/file.js'
import type { Task } from '../../models/task.js'
import { DocumentTextRepository } from '../../repositories/document-text-repository.js'
import { FileRepository } from '../../repositories/file-repository.js'
import { TextChunkRepository } from '../../repositories/text-chunk-repository.js'
import type { SummaryChunkInput } from '../agent/summary-agent.js'
import { chunkDocumentTexts, type ChunkSourcePage } from '../chunk/text-chunker.js'
import { OperationLogger } from '../operation-logger.js'
import { cleanPdfText } from '../pdf/pdf-text-cleaner.js'
import { extractPdfPages } from '../pdf/pdf-text-extractor.js'
import { SummaryService } from '../summary-service.js'
import { TaskRepository } from '../../repositories/task-repository.js'
import type { TaskHandler, TaskHandlerResult } from './task-handler.js'

type PdfTask = Task & { fileId: string }

function assertPdfTask(task: Task): asserts task is PdfTask {
  if (!task.fileId) {
    throw new ApplicationError('TASK_EXECUTION_FAILED', { message: 'PDF 任务缺少文件', taskId: task.id })
  }
}

const EXTRACT_TEXT_PROGRESS = 10
const SAVE_DOCUMENT_TEXT_PROGRESS = 30
const CREATE_CHUNKS_PROGRESS = 50
const GENERATE_SUMMARY_PROGRESS = 70
const SAVE_SUMMARY_PROGRESS = 90
const COMPLETED_PROGRESS = 100
const CHUNK_FAILED_MESSAGE = '文本分块失败'

export type PdfTaskHandlerDependencies = {
  taskRepository: TaskRepository
  fileRepository: FileRepository
  documentTextRepository: DocumentTextRepository
  textChunkRepository: TextChunkRepository
  summaryService: SummaryService
  operationLogger: OperationLogger
  extractPdfPages?: (absolutePath: string) => Promise<ChunkSourcePage[]>
  chunkDocumentTexts?: (pages: readonly ChunkSourcePage[]) => ReturnType<typeof chunkDocumentTexts>
}

export class PdfTaskHandler implements TaskHandler {
  readonly taskType = 'PROCESS_PDF' as const
  private readonly extractPdfPages: (absolutePath: string) => Promise<ChunkSourcePage[]>
  private readonly chunkDocumentTexts: (pages: readonly ChunkSourcePage[]) => ReturnType<typeof chunkDocumentTexts>

  constructor(private readonly dependencies: PdfTaskHandlerDependencies) {
    this.extractPdfPages = dependencies.extractPdfPages ?? extractPdfPages
    this.chunkDocumentTexts = dependencies.chunkDocumentTexts ?? chunkDocumentTexts
  }

  async execute(task: Task): Promise<TaskHandlerResult> {
    assertPdfTask(task)
    this.markFile(task.fileId, 'EXTRACTING')
    if (this.dependencies.taskRepository.updateRunning(task.id, 'EXTRACT_TEXT', EXTRACT_TEXT_PROGRESS) !== 1) return { finished: false }
    const pages = (await this.extractText(task)).map((page) => ({
      pageNumber: page.pageNumber,
      content: cleanPdfText(page.content),
    }))
    if (this.dependencies.taskRepository.updateRunning(task.id, 'SAVE_DOCUMENT_TEXT', SAVE_DOCUMENT_TEXT_PROGRESS) !== 1) return { finished: false }
    this.saveDocumentTexts(task, pages)
    this.markFile(task.fileId, 'EXTRACTED')
    if (this.dependencies.taskRepository.updateRunning(task.id, 'CREATE_CHUNKS', CREATE_CHUNKS_PROGRESS) !== 1) return { finished: false }
    this.saveChunks(task, pages)
    const chunks = this.toSummaryChunks(this.dependencies.textChunkRepository.findByFileId(task.fileId))
    if (this.dependencies.taskRepository.updateRunning(task.id, 'GENERATE_SUMMARY', GENERATE_SUMMARY_PROGRESS) !== 1) return { finished: false }
    this.markFile(task.fileId, 'SUMMARIZING')
    const draft = await this.dependencies.summaryService.generate(task, chunks)
    if (this.dependencies.taskRepository.updateRunning(task.id, 'SAVE_SUMMARY', SAVE_SUMMARY_PROGRESS) !== 1) return { finished: false }
    this.dependencies.summaryService.save(task, draft)
    if (this.dependencies.taskRepository.updateRunning(task.id, 'COMPLETED', COMPLETED_PROGRESS) !== 1) return { finished: false }
    this.markFile(task.fileId, 'COMPLETED')
    return { finished: true }
  }

  private async extractText(task: PdfTask): Promise<ChunkSourcePage[]> {
    this.dependencies.operationLogger.log({
      requestId: task.requestId,
      fileId: task.fileId,
      taskId: task.id,
      operation: 'PDF_EXTRACTION_STARTED',
      status: 'STARTED',
    })
    const file = this.dependencies.fileRepository.findById(task.fileId)
    if (!file) {
      throw new ApplicationError('FILE_NOT_FOUND', { fileId: task.fileId, taskId: task.id })
    }

    try {
      const pages = await this.extractPdfPages(resolve(process.cwd(), file.storagePath))
      this.dependencies.operationLogger.log({
        requestId: task.requestId,
        fileId: task.fileId,
        taskId: task.id,
        operation: 'PDF_EXTRACTION_COMPLETED',
        status: 'SUCCEEDED',
      })
      return pages
    } catch (error: unknown) {
      if (error instanceof ApplicationError) throw error
      this.dependencies.operationLogger.log({
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

  private saveDocumentTexts(task: PdfTask, pages: readonly ChunkSourcePage[]): void {
    try {
      this.dependencies.documentTextRepository.replaceForFile(task.fileId, pages.map((page) => ({
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

  private saveChunks(task: PdfTask, pages: readonly ChunkSourcePage[]): void {
    try {
      const drafts = this.chunkDocumentTexts(pages)
      this.dependencies.textChunkRepository.createChunks(task.fileId, drafts.map((draft) => ({
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
    const updated = this.dependencies.fileRepository.update(fileId, {
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
}
