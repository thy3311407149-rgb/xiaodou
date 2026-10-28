import { randomUUID } from 'node:crypto'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { getDatabaseConnection } from '../db/connection.js'
import { ApplicationError } from '../core/errors/application-error.js'
import { logger } from '../core/logger.js'
import type { File, FileStatus } from '../models/file.js'
import type { Summary } from '../models/summary.js'
import type { Task } from '../models/task.js'
import { DocumentTextRepository } from '../repositories/document-text-repository.js'
import { FileRepository } from '../repositories/file-repository.js'
import { SummaryRepository } from '../repositories/summary-repository.js'
import { TaskRepository } from '../repositories/task-repository.js'
import { OperationLogger } from './operation-logger.js'

function isActiveTaskConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  const code = String((error as { code: unknown }).code)
  if (code !== 'SQLITE_CONSTRAINT_UNIQUE' && code !== 'SQLITE_CONSTRAINT') return false
  const message = error instanceof Error ? error.message : ''
  return message.includes('ux_tasks_one_active_per_file') || message.includes('tasks.file_id')
}

const DEMO_USER_ID = 'demo-user'
const deletableStatuses: FileStatus[] = ['UPLOADED', 'UPLOAD_FAILED', 'EXTRACTION_FAILED', 'SUMMARY_FAILED', 'COMPLETED']

export type FileServiceDependencies = {
  fileRepository?: FileRepository
  taskRepository?: TaskRepository
  summaryRepository?: SummaryRepository
  documentTextRepository?: DocumentTextRepository
  operationLogger?: OperationLogger
  database?: ReturnType<typeof getDatabaseConnection>
  uploadDir?: string
}

export type UploadedFileResult = {
  file: File
  task: Task
}

export type UploadedFileInput = {
  temporaryPath: string
  originalName: string
  mimeType: string
  size: number
  requestId: string
  id?: string
}

export class FileService {
  private readonly fileRepository: FileRepository
  private readonly taskRepository: TaskRepository
  private readonly summaryRepository: SummaryRepository
  private readonly documentTextRepository: DocumentTextRepository
  private readonly operationLogger: OperationLogger
  private readonly database: ReturnType<typeof getDatabaseConnection>
  private readonly uploadDir: string

  constructor(dependencies: FileServiceDependencies = {}) {
    this.database = dependencies.database ?? getDatabaseConnection()
    this.fileRepository = dependencies.fileRepository ?? new FileRepository(this.database)
    this.taskRepository = dependencies.taskRepository ?? new TaskRepository(this.database)
    this.summaryRepository = dependencies.summaryRepository ?? new SummaryRepository(this.database)
    this.documentTextRepository = dependencies.documentTextRepository ?? new DocumentTextRepository(this.database)
    this.operationLogger = dependencies.operationLogger ?? new OperationLogger()
    this.uploadDir = resolve(dependencies.uploadDir ?? './uploads')
  }

  async upload(input: UploadedFileInput): Promise<UploadedFileResult> {
    const fileId = input.id ?? randomUUID()
    const taskId = randomUUID()
    const finalName = `${fileId}.pdf`
    const finalPath = resolve(this.uploadDir, finalName)
    const storagePath = relative(resolve(process.cwd()), finalPath).replaceAll('\\', '/')

    // The file row does not exist yet, so fileId cannot be attached without violating the FK.
    this.operationLogger.log({ requestId: input.requestId, operation: 'FILE_UPLOAD_STARTED', status: 'STARTED' })

    try {
      await mkdir(dirname(finalPath), { recursive: true })
      await rename(input.temporaryPath, finalPath)
      const saved = this.database.transaction(() => {
        const file = this.fileRepository.create({
          id: fileId,
          userId: DEMO_USER_ID,
          fileName: input.originalName,
          fileType: 'application/pdf',
          fileSize: input.size,
          storagePath,
          status: 'UPLOADED',
        })
        const task = this.taskRepository.create({
          id: taskId,
          fileId,
          taskType: 'PROCESS_PDF',
          status: 'QUEUED',
          currentStep: 'EXTRACT_TEXT',
          progress: 0,
          retryCount: 0,
          requestId: input.requestId,
        })
        this.operationLogger.log({
          requestId: input.requestId,
          fileId,
          taskId,
          operation: 'TASK_CREATED',
          status: 'SUCCEEDED',
        })
        return { file, task }
      })()
      this.operationLogger.log({ requestId: input.requestId, fileId, operation: 'FILE_UPLOAD_COMPLETED', status: 'SUCCEEDED' })
      logger.info('TASK_CREATED', {
        requestId: input.requestId,
        fileId,
        taskId: saved.task.id,
        operation: 'TASK_CREATED',
        status: 'SUCCEEDED',
      })
      return saved
    } catch (error: unknown) {
      await this.removeFileAfterFailure(finalPath, input.temporaryPath, input.requestId, fileId)
      this.operationLogger.log({ requestId: input.requestId, operation: 'FILE_UPLOAD_FAILED', status: 'FAILED', errorMessage: 'File upload failed' })
      if (error instanceof ApplicationError) throw error
      if (isActiveTaskConflict(error)) {
        throw new ApplicationError('TASK_ALREADY_RUNNING', { fileId, cause: error })
      }
      throw new ApplicationError('FILE_SAVE_FAILED', { fileId, cause: error })
    }
  }

  list(userId = DEMO_USER_ID, limit = 20, offset = 0): File[] {
    return this.fileRepository.listByUser(userId, limit, offset).filter((file) => file.status !== 'DELETED')
  }

  getById(fileId: string): File {
    const file = this.fileRepository.findById(fileId)
    if (!file || file.status === 'DELETED') {
      throw new ApplicationError('FILE_NOT_FOUND', { fileId })
    }
    return file
  }

  getDocumentText(fileId: string): Array<{ pageNumber: number; content: string }> {
    this.getById(fileId)
    return this.documentTextRepository.findByFileId(fileId).map((page) => ({
      pageNumber: page.pageNumber,
      content: page.content,
    }))
  }

  async openPdf(fileId: string): Promise<string> {
    const file = this.getById(fileId)
    const absolutePath = this.resolveStoredPdf(file.storagePath)
    try {
      const info = await stat(absolutePath)
      if (!info.isFile()) throw new ApplicationError('FILE_NOT_FOUND', { fileId })
    } catch (error: unknown) {
      if (error instanceof ApplicationError) throw error
      throw new ApplicationError('FILE_NOT_FOUND', { fileId })
    }
    return absolutePath
  }

  getDetail(fileId: string): { file: File; task: Task | null; summary: Summary | null } {
    const file = this.getById(fileId)
    return {
      file,
      task: this.taskRepository.findLatestByFileId(fileId),
      summary: this.summaryRepository.findLatestByFileId(fileId),
    }
  }

  async delete(fileId: string, requestId: string): Promise<File> {
    const file = this.getById(fileId)
    if (!deletableStatuses.includes(file.status)) {
      throw new ApplicationError('INVALID_FILE_STATE', { fileId })
    }

    const markDeleted = this.database.transaction(() => {
      const updated = this.fileRepository.update(fileId, { status: 'DELETED', errorCode: null, errorMessage: null })
      if (!updated) throw new ApplicationError('FILE_NOT_FOUND', { fileId })
      return updated
    })
    const deletedFile = markDeleted()
    const absolutePath = resolve(process.cwd(), file.storagePath)

    try {
      await unlink(absolutePath)
      logger.info('FILE_DELETED', { requestId, fileId, status: 'SUCCEEDED' })
    } catch (error: unknown) {
      this.operationLogger.log({ requestId, fileId, operation: 'FILE_DELETE_FAILED', status: 'FAILED', errorMessage: 'Local file deletion failed' })
      console.error(error)
    }

    return deletedFile
  }

  private resolveStoredPdf(storagePath: string): string {
    const uploadRoot = resolve(this.uploadDir)
    const absolutePath = resolve(process.cwd(), storagePath)
    const relativePath = relative(uploadRoot, absolutePath)
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new ApplicationError('FILE_NOT_FOUND')
    }
    return absolutePath
  }

  private async removeFileAfterFailure(finalPath: string, temporaryPath: string, requestId: string, fileId: string): Promise<void> {
    for (const path of [finalPath, temporaryPath]) {
      try {
        await unlink(path)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.operationLogger.log({ requestId, fileId, operation: 'FILE_UPLOAD_FAILED', status: 'FAILED', errorMessage: 'Upload compensation failed' })
          console.error(error)
        }
      }
    }
  }
}
