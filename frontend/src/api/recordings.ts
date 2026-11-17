import { ApiError, REQUEST_FAILED_MESSAGE, http, type HttpRequest } from './http.ts'

export type RecordingStatus = 'CREATED' | 'RECORDING' | 'PAUSED' | 'INTERRUPTED' | 'ENDED' | 'DELETED'
export type AudioAsrStatus = 'SKIPPED' | 'SUCCEEDED' | 'FAILED'
export type RecordingTaskStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'
export type RecordingTaskStep =
  | 'PERSIST_AUDIO'
  | 'TRANSCRIBE_AUDIO'
  | 'SAVE_TRANSCRIPT'
  | 'GENERATE_SUMMARY'
  | 'SAVE_SUMMARY'
  | 'EXTRACT_KNOWLEDGE'
  | 'COMPLETED'

export type Recording = {
  id: string
  title: string
  status: RecordingStatus
  mimeType: string | null
  sampleRate: number | null
  startedAt: string | null
  endedAt: string | null
  interruptedAt: string | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

export type RecordingChunk = {
  id: string
  recordingId: string
  sequence: number
  byteSize: number
  sha256: string
  mimeType: string
  asrStatus: AudioAsrStatus
  createdAt: string
}

export type TranscriptSegment = {
  id: string
  recordingId: string
  segmentIndex: number
  audioSequence: number | null
  content: string
  startTimeMs: number
  endTimeMs: number
  speakerId: string | null
  createdAt: string
}

export type KnowledgePoint = {
  id: string
  knowledgeItemId: string
  recordingId: string
  sourceSegmentId: string | null
  content: string
  startTimeMs: number | null
  endTimeMs: number | null
  speakerId: string | null
  createdAt: string
}

export type RecordingTask = {
  id: string
  fileId: string | null
  taskType: 'PROCESS_RECORDING'
  status: RecordingTaskStatus
  currentStep: RecordingTaskStep
  progress: number
  errorCode: string | null
  errorMessage: string | null
  startedAt: string | null
  finishedAt: string | null
}

export type RecordingSummary = {
  id: string
  content: string
  recordingId: string | null
}

export type RecordingDetail = {
  recording: Recording
  knowledgeItemId: string | null
  chunks: RecordingChunk[]
  segments: TranscriptSegment[]
  knowledgePoints: KnowledgePoint[]
  summary: RecordingSummary | null
  task: RecordingTask | null
}

export type RecordingListItem = {
  recordingId: string
  title: string
  createdAt: string
  durationMs: number | null
  status: RecordingStatus
  processingStatus: RecordingTaskStatus | null
  summaryGenerated: boolean
}

export type RecordingListPage = {
  items: RecordingListItem[]
  page: number
  pageSize: number
  total: number
}

const RECORDING_STATUSES: RecordingStatus[] = ['CREATED', 'RECORDING', 'PAUSED', 'INTERRUPTED', 'ENDED', 'DELETED']
const ASR_STATUSES: AudioAsrStatus[] = ['SKIPPED', 'SUCCEEDED', 'FAILED']
const TASK_STATUSES: RecordingTaskStatus[] = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED']
const TASK_STEPS: RecordingTaskStep[] = [
  'PERSIST_AUDIO',
  'TRANSCRIBE_AUDIO',
  'SAVE_TRANSCRIPT',
  'GENERATE_SUMMARY',
  'SAVE_SUMMARY',
  'EXTRACT_KNOWLEDGE',
  'COMPLETED',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function parseRecording(value: unknown): Recording | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return null
  if (typeof value.title !== 'string') return null
  if (typeof value.status !== 'string' || !RECORDING_STATUSES.some((status) => status === value.status)) return null
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return null
  return {
    id: value.id,
    title: value.title,
    status: value.status as RecordingStatus,
    mimeType: nullableString(value.mimeType),
    sampleRate: nullableNumber(value.sampleRate),
    startedAt: nullableString(value.startedAt),
    endedAt: nullableString(value.endedAt),
    interruptedAt: nullableString(value.interruptedAt),
    errorCode: nullableString(value.errorCode),
    errorMessage: nullableString(value.errorMessage),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

export function parseRecordingTask(value: unknown): RecordingTask | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return null
  if (value.taskType !== 'PROCESS_RECORDING') return null
  if (typeof value.status !== 'string' || !TASK_STATUSES.some((status) => status === value.status)) return null
  if (typeof value.currentStep !== 'string' || !TASK_STEPS.some((step) => step === value.currentStep)) return null
  if (typeof value.progress !== 'number' || !Number.isFinite(value.progress)) return null
  return {
    id: value.id,
    fileId: typeof value.fileId === 'string' ? value.fileId : null,
    taskType: 'PROCESS_RECORDING',
    status: value.status as RecordingTaskStatus,
    currentStep: value.currentStep as RecordingTaskStep,
    progress: value.progress,
    errorCode: nullableString(value.errorCode),
    errorMessage: nullableString(value.errorMessage),
    startedAt: nullableString(value.startedAt),
    finishedAt: nullableString(value.finishedAt),
  }
}

function parseChunk(value: unknown): RecordingChunk | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.recordingId !== 'string') return null
  if (typeof value.sequence !== 'number' || typeof value.byteSize !== 'number' || typeof value.sha256 !== 'string') return null
  if (typeof value.mimeType !== 'string' || typeof value.createdAt !== 'string') return null
  if (typeof value.asrStatus !== 'string' || !ASR_STATUSES.some((status) => status === value.asrStatus)) return null
  return {
    id: value.id,
    recordingId: value.recordingId,
    sequence: value.sequence,
    byteSize: value.byteSize,
    sha256: value.sha256,
    mimeType: value.mimeType,
    asrStatus: value.asrStatus as AudioAsrStatus,
    createdAt: value.createdAt,
  }
}

export function parseTranscriptSegment(value: unknown): TranscriptSegment | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.recordingId !== 'string') return null
  if (typeof value.segmentIndex !== 'number' || typeof value.content !== 'string') return null
  if (typeof value.startTimeMs !== 'number' || typeof value.endTimeMs !== 'number' || typeof value.createdAt !== 'string') return null
  return {
    id: value.id,
    recordingId: value.recordingId,
    segmentIndex: value.segmentIndex,
    audioSequence: nullableNumber(value.audioSequence),
    content: value.content,
    startTimeMs: value.startTimeMs,
    endTimeMs: value.endTimeMs,
    speakerId: nullableString(value.speakerId),
    createdAt: value.createdAt,
  }
}

function parseKnowledgePoint(value: unknown): KnowledgePoint | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.content !== 'string') return null
  if (typeof value.knowledgeItemId !== 'string' || typeof value.recordingId !== 'string' || typeof value.createdAt !== 'string') return null
  return {
    id: value.id,
    knowledgeItemId: value.knowledgeItemId,
    recordingId: value.recordingId,
    sourceSegmentId: nullableString(value.sourceSegmentId),
    content: value.content,
    startTimeMs: nullableNumber(value.startTimeMs),
    endTimeMs: nullableNumber(value.endTimeMs),
    speakerId: nullableString(value.speakerId),
    createdAt: value.createdAt,
  }
}

function dataOf(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body) || !isRecord(body.data)) return null
  return body.data
}

export function parseRecordingDetail(body: unknown): RecordingDetail | null {
  const data = dataOf(body)
  if (!data) return null
  const recording = parseRecording(data.recording)
  if (!recording) return null
  if (!Array.isArray(data.chunks) || !Array.isArray(data.segments) || !Array.isArray(data.knowledgePoints)) return null
  const chunks: RecordingChunk[] = []
  for (const chunk of data.chunks) {
    const parsed = parseChunk(chunk)
    if (!parsed) return null
    chunks.push(parsed)
  }
  const segments: TranscriptSegment[] = []
  for (const segment of data.segments) {
    const parsed = parseTranscriptSegment(segment)
    if (!parsed) return null
    segments.push(parsed)
  }
  const knowledgePoints: KnowledgePoint[] = []
  for (const point of data.knowledgePoints) {
    const parsed = parseKnowledgePoint(point)
    if (!parsed) return null
    knowledgePoints.push(parsed)
  }
  const task = data.task == null ? null : parseRecordingTask(data.task)
  if (data.task != null && !task) return null
  return {
    recording,
    knowledgeItemId: nullableString(data.knowledgeItemId),
    chunks,
    segments,
    knowledgePoints,
    summary: parseRecordingSummary(data.summary),
    task,
  }
}

export function parseRecordingList(body: unknown): RecordingListPage | null {
  const data = dataOf(body)
  if (!data || !Array.isArray(data.items)) return null
  const page = data.page
  const pageSize = data.pageSize
  const total = data.total
  if (typeof page !== 'number' || typeof pageSize !== 'number' || typeof total !== 'number') return null
  if (!Number.isInteger(page) || !Number.isInteger(pageSize) || !Number.isInteger(total)) return null
  if (page < 1 || pageSize < 1 || total < 0) return null
  const items: RecordingListItem[] = []
  for (const item of data.items) {
    const parsed = parseRecordingListItem(item)
    if (!parsed) return null
    items.push(parsed)
  }
  return { items, page, pageSize, total }
}

function parseRecordingSummary(value: unknown): RecordingSummary | null {
  if (value == null) return null
  if (!isRecord(value) || typeof value.content !== 'string' || !value.content.trim()) return null
  return {
    id: typeof value.id === 'string' ? value.id : '',
    content: value.content,
    recordingId: nullableString(value.recordingId),
  }
}

function parseRecordingListItem(value: unknown): RecordingListItem | null {
  if (!isRecord(value) || typeof value.recordingId !== 'string' || !value.recordingId) return null
  if (typeof value.title !== 'string' || typeof value.createdAt !== 'string') return null
  if (typeof value.status !== 'string' || !RECORDING_STATUSES.some((status) => status === value.status)) return null
  if (value.processingStatus != null && (typeof value.processingStatus !== 'string' || !TASK_STATUSES.some((status) => status === value.processingStatus))) return null
  if (typeof value.summaryGenerated !== 'boolean') return null
  if (value.durationMs != null && (typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs))) return null
  return {
    recordingId: value.recordingId,
    title: value.title,
    createdAt: value.createdAt,
    durationMs: value.durationMs ?? null,
    status: value.status as RecordingStatus,
    processingStatus: value.processingStatus == null ? null : value.processingStatus as RecordingTaskStatus,
    summaryGenerated: value.summaryGenerated,
  }
}

function recordingPath(recordingId: string, suffix = ''): string {
  return `/api/recordings/${encodeURIComponent(recordingId)}${suffix}`
}

export async function createRecording(title: string, request: HttpRequest = http.request): Promise<{ recording: Recording; knowledgeItemId: string | null }> {
  const response = await request('/api/recordings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  if (response.status !== 201) throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
  const data = dataOf(response.body)
  const recording = data ? parseRecording(data.recording) : null
  if (!recording) throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
  return { recording, knowledgeItemId: data ? nullableString(data.knowledgeItemId) : null }
}

export async function fetchRecordingList(page: number, pageSize = 20, request: HttpRequest = http.request): Promise<RecordingListPage> {
  const response = await request(`/api/recordings?page=${page}&pageSize=${pageSize}`)
  const listed = parseRecordingList(response.body)
  if (!listed) throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
  return listed
}

export async function fetchRecording(recordingId: string, request: HttpRequest = http.request): Promise<RecordingDetail> {
  const response = await request(recordingPath(recordingId))
  const detail = parseRecordingDetail(response.body)
  if (!detail || detail.recording.id !== recordingId) throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
  return detail
}

export async function startRecording(recordingId: string, request: HttpRequest = http.request): Promise<Recording> {
  const response = await request(recordingPath(recordingId, '/start'), { method: 'POST' })
  const data = dataOf(response.body)
  const recording = data ? parseRecording(data.recording) : null
  if (!recording) throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
  return recording
}

export async function uploadRecordingChunk(
  recordingId: string,
  sequence: number,
  audio: Blob,
  request: HttpRequest = http.request,
  sampleRate?: number,
): Promise<{ chunk: RecordingChunk; segments: TranscriptSegment[] }> {
  const body = new FormData()
  body.append('sequence', String(sequence))
  if (sampleRate && Number.isInteger(sampleRate) && sampleRate > 0) body.append('sampleRate', String(sampleRate))
  const fileName = `chunk-${sequence}`
  body.append('audio', audio, fileName)
  const response = await request(recordingPath(recordingId, '/chunks'), { method: 'POST', body })
  if (response.status !== 201) throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
  const data = dataOf(response.body)
  const chunk = data ? parseChunk(data.chunk) : null
  if (!data || !chunk || !Array.isArray(data.segments)) throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
  const segments: TranscriptSegment[] = []
  for (const segment of data.segments) {
    const parsed = parseTranscriptSegment(segment)
    if (!parsed) throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
    segments.push(parsed)
  }
  return { chunk, segments }
}

export async function pauseRecording(recordingId: string, request: HttpRequest = http.request): Promise<void> {
  await request(recordingPath(recordingId, '/pause'), { method: 'POST' })
}

export async function resumeRecording(recordingId: string, request: HttpRequest = http.request): Promise<void> {
  await request(recordingPath(recordingId, '/resume'), { method: 'POST' })
}

export async function finishRecording(recordingId: string, request: HttpRequest = http.request): Promise<{ recording: Recording; task: RecordingTask }> {
  const response = await request(recordingPath(recordingId, '/finish'), { method: 'POST' })
  const data = dataOf(response.body)
  const recording = data ? parseRecording(data.recording) : null
  const task = data ? parseRecordingTask(data.task) : null
  if (!recording || !task) throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
  return { recording, task }
}

export async function processRecording(recordingId: string, request: HttpRequest = http.request): Promise<RecordingTask> {
  const response = await request(recordingPath(recordingId, '/process'), { method: 'POST' })
  if (response.status !== 201) throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
  const data = dataOf(response.body)
  const task = data ? parseRecordingTask(data.task) : null
  if (!task) throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
  return task
}

export async function fetchRecordingChunkAudio(
  recordingId: string,
  sequence: number,
  requestMedia: (path: string, init?: RequestInit) => Promise<Blob> = http.requestMedia,
): Promise<Blob> {
  return requestMedia(recordingPath(recordingId, `/chunks/${sequence}`))
}

export async function fetchRecordingTask(taskId: string, request: HttpRequest = http.request): Promise<RecordingTask> {
  const response = await request(`/api/tasks/${encodeURIComponent(taskId)}`)
  const data = dataOf(response.body)
  const task = data ? parseRecordingTask(data.task) : null
  if (!task || task.id !== taskId) throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
  return task
}
