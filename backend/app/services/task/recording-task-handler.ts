import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { ApplicationError } from '../../core/errors/application-error.js'
import { logger } from '../../core/logger.js'
import type { Task } from '../../models/task.js'
import type { TranscriptSegment } from '../../models/recording.js'
import { RecordingRepository } from '../../repositories/recording-repository.js'
import { SummaryRepository } from '../../repositories/summary-repository.js'
import { TaskRepository } from '../../repositories/task-repository.js'
import { inspectAudio, resamplePcm16le, resolveSampleRate } from '../asr/audio-format.js'
import type { AsrProvider } from '../asr/asr-provider.js'
import { createAsrProvider } from '../asr/create-asr-provider.js'
import { KnowledgeItemService } from '../knowledge-item-service.js'
import { SummaryService } from '../summary-service.js'
import type { TaskHandler, TaskHandlerResult } from './task-handler.js'

const PERSIST_AUDIO_PROGRESS = 15
const TRANSCRIBE_AUDIO_PROGRESS = 35
const SAVE_TRANSCRIPT_PROGRESS = 50
const GENERATE_SUMMARY_PROGRESS = 70
const SAVE_SUMMARY_PROGRESS = 85
const EXTRACT_KNOWLEDGE_PROGRESS = 95

export type RecordingTaskHandlerDependencies = {
  taskRepository?: TaskRepository
  recordingRepository?: RecordingRepository
  summaryRepository?: SummaryRepository
  summaryService?: SummaryService
  knowledgeItems?: KnowledgeItemService
  asrProvider?: AsrProvider
  sampleRate?: number
}

export class RecordingTaskHandler implements TaskHandler {
  readonly taskType = 'PROCESS_RECORDING' as const
  private readonly recordings: RecordingRepository
  private readonly summaries: SummaryRepository
  private readonly knowledgeItems: KnowledgeItemService
  private readonly asrProvider: AsrProvider
  private readonly sampleRate: number

  constructor(private readonly dependencies: RecordingTaskHandlerDependencies = {}) {
    this.recordings = dependencies.recordingRepository ?? new RecordingRepository()
    this.summaries = dependencies.summaryRepository ?? new SummaryRepository()
    this.knowledgeItems = dependencies.knowledgeItems ?? new KnowledgeItemService()
    this.asrProvider = dependencies.asrProvider ?? createAsrProvider()
    this.sampleRate = dependencies.sampleRate ?? 16000
    this.dependencies.taskRepository ??= new TaskRepository()
  }

  async execute(task: Task): Promise<TaskHandlerResult> {
    if (!task.recordingId || task.fileId || task.noteId) {
      throw new ApplicationError('TASK_EXECUTION_FAILED', { message: '录音任务缺少录音来源', taskId: task.id })
    }
    const recordingId = task.recordingId
    const recording = this.recordings.findById(recordingId)
    if (!recording) throw new ApplicationError('RECORDING_NOT_FOUND', { taskId: task.id })
    if (this.taskRepository.updateRunning(task.id, 'PERSIST_AUDIO', PERSIST_AUDIO_PROGRESS) !== 1) return { finished: false }
    const chunks = this.recordings.listChunks(recordingId)
    if (chunks.length === 0) {
      this.failRecording(recordingId, new ApplicationError('TASK_EXECUTION_FAILED', { message: '录音没有可处理的音频', taskId: task.id }))
    }
    for (const chunk of chunks) {
      try {
        await readFile(chunk.storagePath)
      } catch (error: unknown) {
        this.failRecording(recordingId, new ApplicationError('TASK_EXECUTION_FAILED', { message: '录音音频文件缺失', taskId: task.id, cause: error }))
      }
    }
    if (this.taskRepository.updateRunning(task.id, 'TRANSCRIBE_AUDIO', TRANSCRIBE_AUDIO_PROGRESS) !== 1) return { finished: false }
    let segments = this.recordings.listSegments(recordingId)
    const needsTranscription = segments.length === 0
    if (!needsTranscription) {
      logger.info('RECORDING_TRANSCRIBE_REUSED', { recordingId, taskId: task.id, segments: segments.length })
    }
    if (needsTranscription) {
      logger.info('RECORDING_TRANSCRIBE_RECOVERY', { recordingId, taskId: task.id })
      if (!this.asrProvider.isConfigured()) {
        if (segments.length === 0) this.failRecording(recordingId, new ApplicationError('ASR_UNAVAILABLE', { taskId: task.id }))
      } else {
        try {
          segments = await this.transcribeStoredAudio(recordingId, chunks.map((chunk) => ({
            sequence: chunk.sequence,
            storagePath: chunk.storagePath,
            mimeType: chunk.mimeType,
          })), recording.sampleRate ?? this.sampleRate)
        } catch (error: unknown) {
          const applicationError = error instanceof ApplicationError
            ? error
            : new ApplicationError('ASR_FAILED', { taskId: task.id, cause: error })
          this.failRecording(recordingId, applicationError)
        }
      }
    }
    if (this.taskRepository.updateRunning(task.id, 'SAVE_TRANSCRIPT', SAVE_TRANSCRIPT_PROGRESS) !== 1) return { finished: false }
    if (segments.length === 0) {
      this.failRecording(recordingId, new ApplicationError('TASK_EXECUTION_FAILED', { message: '没有可保存的转写文本', taskId: task.id }))
    }
    if (!this.dependencies.summaryService) {
      this.failRecording(recordingId, new ApplicationError('TASK_EXECUTION_FAILED', { message: '摘要服务不可用', taskId: task.id }))
    }
    if (this.taskRepository.updateRunning(task.id, 'GENERATE_SUMMARY', GENERATE_SUMMARY_PROGRESS) !== 1) return { finished: false }
    const draft = await this.dependencies.summaryService.summarizeChunks(task, segments.map((segment) => ({
      chunkId: segment.id,
      chunkIndex: segment.segmentIndex,
      pageNumber: null,
      content: segment.content,
    })))
    if (this.taskRepository.updateRunning(task.id, 'SAVE_SUMMARY', SAVE_SUMMARY_PROGRESS) !== 1) return { finished: false }
    const summary = this.summaries.replaceForTask({
      id: randomUUID(),
      recordingId,
      taskId: task.id,
      content: draft.summary,
      keyPoints: draft.keyPoints,
      citations: draft.citations,
      modelName: draft.modelName,
      promptVersion: draft.promptVersion,
      inputTokens: draft.inputTokens,
      outputTokens: draft.outputTokens,
    })
    const item = this.knowledgeItems.ensureForSource({
      sourceType: 'RECORDING',
      sourceId: recordingId,
      title: recording.title,
      status: 'ACTIVE',
    })
    this.knowledgeItems.replaceCurrentSummary(item.id, summary.id)
    if (this.taskRepository.updateRunning(task.id, 'EXTRACT_KNOWLEDGE', EXTRACT_KNOWLEDGE_PROGRESS) !== 1) return { finished: false }
    const keyPoints = draft.keyPoints.length > 0 ? draft.keyPoints : [{
      content: firstSentence(draft.summary),
      sourceChunkIndexes: [segments[0]?.segmentIndex ?? 0],
    }]
    this.recordings.replaceKnowledgePoints(recordingId, knowledgePointsFrom(item.id, keyPoints, segments))
    return { finished: true }
  }

  private get taskRepository(): TaskRepository {
    return this.dependencies.taskRepository ?? new TaskRepository()
  }

  private failRecording(recordingId: string, error: ApplicationError): never {
    this.recordings.update(recordingId, { errorCode: error.code, errorMessage: error.message })
    throw error
  }

  private async transcribeStoredAudio(
    recordingId: string,
    chunks: Array<{ sequence: number; storagePath: string; mimeType: string }>,
    sampleRate: number,
  ): Promise<TranscriptSegment[]> {
    const first = await readFile(chunks[0]?.storagePath ?? '')
    const inspected = inspectAudio(first, chunks[0]?.mimeType ?? '')
    if (!inspected.compatible) throw new ApplicationError('ASR_FAILED', { message: inspected.reason })
    const rate = resolveSampleRate(inspected.sampleRate, sampleRate)
    if (!('sampleRate' in rate)) throw new ApplicationError('ASR_FAILED', { message: rate.reason })
    const sessionRate = inspected.format === 'pcm' ? this.sampleRate : rate.sampleRate
    const session = await this.asrProvider.openSession({ format: inspected.format, sampleRate: sessionRate })
    try {
      const recognized = []
      for (const chunk of chunks) {
        const audio = await readFile(chunk.storagePath)
        const outbound = inspected.format === 'pcm' ? resamplePcm16le(audio, rate.sampleRate, sessionRate) : audio
        recognized.push(...await session.pushAudio(outbound))
      }
      recognized.push(...await session.finish())
      return this.recordings.replaceSegments(recordingId, recognized.map((segment, index) => ({
        id: randomUUID(),
        segmentIndex: index,
        audioSequence: null,
        content: segment.text,
        startTimeMs: segment.startTimeMs,
        endTimeMs: segment.endTimeMs,
        speakerId: segment.speakerId,
      })))
    } catch (error: unknown) {
      if (error instanceof ApplicationError) throw error
      throw new ApplicationError('ASR_FAILED', { cause: error })
    }
  }
}

function firstSentence(summary: string): string {
  const sentence = summary.replace(/\s+/g, ' ').trim().split(/[。！？]/)[0]?.trim() ?? ''
  return sentence || summary.trim()
}

function knowledgePointsFrom(
  knowledgeItemId: string,
  keyPoints: Array<{ content: string; sourceChunkIndexes: number[] }>,
  segments: TranscriptSegment[],
): Array<{
  id: string
  knowledgeItemId: string
  sourceSegmentId: string | null
  content: string
  startTimeMs: number | null
  endTimeMs: number | null
  speakerId: string | null
}> {
  return keyPoints.flatMap((point) => {
    const cited = point.sourceChunkIndexes.flatMap((index) => {
      const segment = segments.find((item) => item.segmentIndex === index)
      return segment ? [segment] : []
    })
    const anchored = cited.length > 0 ? cited : segments
    if (!point.content.trim() || anchored.length === 0) return []
    const speakers = [...new Set(anchored.flatMap((segment) => segment.speakerId ? [segment.speakerId] : []))]
    return [{
      id: randomUUID(),
      knowledgeItemId,
      sourceSegmentId: anchored[0]?.id ?? null,
      content: point.content,
      startTimeMs: Math.min(...anchored.map((segment) => segment.startTimeMs)),
      endTimeMs: Math.max(...anchored.map((segment) => segment.endTimeMs)),
      speakerId: speakers.length === 1 ? speakers[0] ?? null : null,
    }]
  }).filter((point) => point.content.trim().length > 0)
}
