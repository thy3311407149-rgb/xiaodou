import { ApiError, REQUEST_FAILED_MESSAGE, type HttpRequest } from '../api/http.ts'
import {
  createRecording,
  fetchRecording,
  fetchRecordingTask,
  finishRecording,
  parseRecordingTask,
  pauseRecording,
  processRecording,
  resumeRecording,
  startRecording,
  uploadRecordingChunk,
  type AudioAsrStatus,
  type KnowledgePoint,
  type Recording,
  type RecordingDetail,
  type RecordingTask,
  type TranscriptSegment,
} from '../api/recordings.ts'
import { ChunkQueue } from './chunk-queue.ts'
import { selectRecordingMime } from './mime.ts'
import { watchRecordingTask } from './poll.ts'
import {
  applyTranscriptEvent,
  confirmedSegments,
  arrayBufferFrom,
  encodePcmFrame,
  parseServerEvent,
  type PcmSource,
  type RecordingSocket,
  type ServerEvent,
} from './realtime.ts'
import type { TimerId } from '../upload/task-poller.ts'

export const CHUNK_TIMESLICE_MS = 4000
export const MIC_PERMISSION_MESSAGE = '需要麦克风权限才能开始录音，请允许浏览器访问麦克风后重试。'
export const RECORDER_UNSUPPORTED_MESSAGE = '当前浏览器不支持录音'
export const MIME_UNSUPPORTED_MESSAGE = '当前浏览器录音格式暂不兼容'
export const MIC_MISSING_MESSAGE = '没有检测到可用的麦克风'
export const MIC_BUSY_MESSAGE = '麦克风正被其他程序占用'
export const AUDIO_SAVED_MESSAGE = '音频已保存'
export const LIVE_TRANSCRIPT_UNAVAILABLE_MESSAGE = '实时转写暂不可用'
export const PROCESS_UNAVAILABLE_MESSAGE = '转写和 AI 处理暂不可用'

export type RecordingPhase = 'idle' | 'requesting' | 'recording' | 'upload-error' | 'finishing' | 'processing' | 'done' | 'failed'

export type RecordingView = {
  phase: RecordingPhase
  message: string | null
  mimeType: string | null
  browserSampleRate: number | null
  savedChunks: number
  segments: TranscriptSegment[]
  liveTranscriptUnavailable: boolean
  audioSaved: boolean
  recording: Recording | null
  knowledgePoints: KnowledgePoint[]
  task: RecordingTask | null
  startedAtMs: number | null
  paused: boolean
  pausedAtMs: number | null
  pausedTotalMs: number
  canPause: boolean
}

export type MediaStreamLike = {
  getTracks: () => Array<{ stop: () => void }>
}

export type RecorderHandle = {
  start: (timeslice: number) => void
  stop: () => void
  pause?: () => void
  resume?: () => void
  addEventListener: (type: 'dataavailable' | 'stop' | 'error', listener: (event: { data?: Blob }) => void) => void
}

export type RecordingMedia = {
  pcmAvailable: boolean
  createPcmSource: (stream: MediaStreamLike) => Promise<PcmSource>
  createSocket: (recordingId: string) => RecordingSocket
  recorderAvailable: boolean
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStreamLike>
  isTypeSupported: (mime: string) => boolean
  createRecorder: (stream: MediaStreamLike, mime: string) => RecorderHandle
}

export type RecordingClock = {
  now: () => number
  setTimer: (callback: () => void, delayMs: number) => TimerId
  clearTimer: (id: TimerId) => void
}

export type RecordingSessionOptions = {
  request: HttpRequest
  media: RecordingMedia
  clock: RecordingClock
  onChange: (view: RecordingView) => void
}

type PendingFrame = {
  sequence: number
  timestampMs: number
  pcm: Uint8Array
}

type Waiter = {
  resolve: () => void
  reject: (error: Error) => void
  timer: TimerId
}

function idleView(): RecordingView {
  return {
    phase: 'idle',
    message: null,
    mimeType: null,
    browserSampleRate: null,
    savedChunks: 0,
    segments: [],
    liveTranscriptUnavailable: false,
    audioSaved: false,
    recording: null,
    knowledgePoints: [],
    task: null,
    startedAtMs: null,
    paused: false,
    pausedAtMs: null,
    pausedTotalMs: 0,
    canPause: false,
  }
}

function errorName(error: unknown): string {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) return error.name
  if (error instanceof Error) return error.name
  return ''
}

function visibleError(error: unknown): string {
  if (error instanceof ApiError && error.message && error.message !== REQUEST_FAILED_MESSAGE) return error.message
  if (error instanceof Error && error.message && error.message !== 'ready' && error.message !== 'resume' && error.message !== 'completed') return error.message
  return REQUEST_FAILED_MESSAGE
}

function mergeSegments(current: TranscriptSegment[], incoming: TranscriptSegment[]): TranscriptSegment[] {
  const byId = new Map(current.map((segment) => [segment.id, segment]))
  for (const segment of incoming) byId.set(segment.id, segment)
  return [...byId.values()].sort((left, right) => left.segmentIndex - right.segmentIndex)
}

export class RecordingSession {
  private viewState = idleView()
  private epoch = 0
  private boundEpoch = 0
  private disposed = false
  private stream: MediaStreamLike | null = null
  private recorder: RecorderHandle | null = null
  private queue: ChunkQueue<{ segments: TranscriptSegment[]; asrStatus: AudioAsrStatus }> | null = null
  private stopPoll: (() => void) | null = null
  private recordingId: string | null = null
  private mode: 'pcm' | 'webm' | null = null
  private pcm: PcmSource | null = null
  private socket: RecordingSocket | null = null
  private socketGeneration = 0
  private sampleRate = 0
  private sequence = 0
  private samplesSent = 0
  private acceptedFrames = 0
  private pending: PendingFrame[] = []
  private pumping = false
  private halted = false
  private lastError: unknown = null
  private capturePaused = false
  private reconnects = 0
  private connecting = false
  private completedTask: RecordingTask | null = null
  private liveUnavailable = false
  private control: Promise<void> = Promise.resolve()
  private drain: { resolve: () => void; reject: (error: unknown) => void } | null = null
  private waiters = new Map<string, Waiter>()
  private readonly options: RecordingSessionOptions

  constructor(options: RecordingSessionOptions) {
    this.options = options
  }

  get view(): RecordingView {
    return this.viewState
  }

  start(): Promise<void> {
    return this.enqueueControl(() => this.startNow())
  }

  pause(): Promise<void> {
    return this.enqueueControl(() => this.pauseNow())
  }

  stop(): Promise<void> {
    return this.enqueueControl(() => this.stopNow())
  }

  retryUpload(): void {
    if (this.viewState.phase !== 'upload-error') return
    if (this.mode === 'pcm') {
      this.halted = false
      this.lastError = null
      this.publish({ ...this.viewState, phase: 'recording', message: null })
      void this.pump()
      return
    }
    this.queue?.retry()
    this.publish({ ...this.viewState, message: null })
  }

  async reprocess(): Promise<void> {
    if (!this.recordingId || this.viewState.phase !== 'failed') return
    const epoch = this.epoch
    try {
      const task = await processRecording(this.recordingId, this.options.request)
      if (epoch !== this.epoch) return
      this.publish({ ...this.viewState, phase: 'processing', task, message: null })
      this.poll(epoch, task.id)
    } catch (error: unknown) {
      if (epoch !== this.epoch) return
      this.publish({ ...this.viewState, message: visibleError(error) })
    }
  }

  dispose(): void {
    this.disposed = true
    this.boundEpoch = -1
    this.epoch += 1
    this.capturePaused = true
    this.socketGeneration += 1
    for (const kind of [...this.waiters.keys()]) this.clearWaiter(kind, true)
    this.stopPoll?.()
    this.stopPoll = null
    const pcm = this.pcm
    this.pcm = null
    if (pcm) {
      void pcm.stop().then((tail) => {
        this.enqueuePcm(tail)
        void this.waitForDrain().finally(() => this.socket?.close())
      })
    } else {
      this.socket?.close()
    }
    void this.stopRecorder()
    this.disposeMedia()
  }

  private enqueueControl(work: () => Promise<void>): Promise<void> {
    const run = this.control.then(work, work)
    this.control = run.then(() => undefined, () => undefined)
    return run
  }

  private async startNow(): Promise<void> {
    if (this.disposed) return
    if (this.viewState.phase === 'failed' && this.viewState.audioSaved && this.recordingId && this.viewState.recording?.status !== 'ENDED') {
      await this.stopNow()
      return
    }
    if (this.viewState.phase === 'recording' || this.viewState.phase === 'requesting' || this.viewState.phase === 'finishing') return
    const epoch = ++this.epoch
    this.boundEpoch = epoch
    this.resetTransport()
    this.stopPoll?.()
    this.stopPoll = null
    const pcmOk = this.options.media.pcmAvailable
    const mimeType = selectRecordingMime(this.options.media.isTypeSupported)
    if (!pcmOk && !this.options.media.recorderAvailable) {
      this.publish({ ...idleView(), phase: 'failed', message: RECORDER_UNSUPPORTED_MESSAGE })
      return
    }
    if (!pcmOk && !mimeType) {
      this.publish({ ...idleView(), phase: 'failed', message: MIME_UNSUPPORTED_MESSAGE })
      return
    }
    this.publish({ ...idleView(), phase: 'requesting' })
    let stream: MediaStreamLike
    try {
      stream = await this.options.media.getUserMedia({ audio: true })
    } catch (error: unknown) {
      if (epoch !== this.epoch) return
      this.publish({ ...idleView(), phase: 'failed', message: microphoneMessage(error) })
      return
    }
    if (epoch !== this.epoch || this.disposed) {
      stopStream(stream)
      return
    }
    this.stream = stream
    if (pcmOk) {
      try {
        const source = await this.options.media.createPcmSource(stream)
        if (epoch !== this.epoch) {
          await source.stop()
          this.disposeMedia()
          return
        }
        if (source.sampleRate > 0) {
          await this.startPcm(epoch, source)
          return
        }
        await source.stop()
      } catch (error: unknown) {
        if (epoch !== this.epoch) return
        if (!mimeType || !this.options.media.recorderAvailable) {
          this.disposeMedia()
          this.publish({ ...idleView(), phase: 'failed', message: visibleError(error) })
          return
        }
      }
    }
    if (!mimeType) {
      this.disposeMedia()
      this.publish({ ...idleView(), phase: 'failed', message: MIME_UNSUPPORTED_MESSAGE })
      return
    }
    await this.startWebm(epoch, stream, mimeType)
  }

  private async startPcm(epoch: number, source: PcmSource): Promise<void> {
    this.mode = 'pcm'
    this.sampleRate = source.sampleRate
    this.pcm = source
    try {
      const created = await createRecording('录音', this.options.request)
      if (epoch !== this.epoch) {
        await source.stop()
        this.disposeMedia()
        return
      }
      const started = await startRecording(created.recording.id, this.options.request)
      if (epoch !== this.epoch) {
        await source.stop()
        this.disposeMedia()
        return
      }
      this.recordingId = started.id
      const connected = await this.openSocket(started.id, source.sampleRate)
      if (epoch !== this.epoch) {
        await source.stop()
        this.disposeMedia()
        return
      }
      if (!connected) {
        this.socketGeneration += 1
        this.socket?.close()
        this.socket = null
      }
      source.start((frame) => {
        if (epoch !== this.epoch || this.capturePaused) return
        this.enqueuePcm(frame)
      })
      this.publish({
        ...idleView(),
        phase: 'recording',
        mimeType: 'audio/pcm',
        browserSampleRate: source.sampleRate,
        recording: started,
        startedAtMs: this.options.clock.now(),
        canPause: true,
        liveTranscriptUnavailable: this.liveUnavailable,
        message: this.liveUnavailable ? LIVE_TRANSCRIPT_UNAVAILABLE_MESSAGE : null,
      })
    } catch (error: unknown) {
      if (epoch !== this.epoch) return
      this.capturePaused = true
      await source.stop()
      this.pcm = null
      this.disposeMedia()
      this.publish({ ...idleView(), phase: 'failed', message: visibleError(error) })
    }
  }

  private async startWebm(epoch: number, stream: MediaStreamLike, mimeType: string): Promise<void> {
    this.mode = 'webm'
    try {
      const created = await createRecording('录音', this.options.request)
      if (epoch !== this.epoch) {
        this.disposeMedia()
        return
      }
      const started = await startRecording(created.recording.id, this.options.request)
      if (epoch !== this.epoch) {
        this.disposeMedia()
        return
      }
      this.recordingId = started.id
      const queue = new ChunkQueue(
        (sequence, blob) => this.sendChunk(epoch, started.id, sequence, blob),
        (saved) => {
          if (epoch !== this.epoch) return
          this.publish({
            ...this.viewState,
            savedChunks: saved.saved,
            audioSaved: saved.saved > 0,
            liveTranscriptUnavailable: true,
          })
        },
        (error) => {
          if (epoch !== this.epoch || this.viewState.phase === 'finishing') return
          this.publish({ ...this.viewState, phase: 'upload-error', message: visibleError(error) })
        },
      )
      this.queue = queue
      const recorder = this.options.media.createRecorder(stream, mimeType)
      this.recorder = recorder
      recorder.addEventListener('dataavailable', (event) => {
        if (epoch !== this.epoch || !event.data || event.data.size <= 0) return
        const typed = event.data.type === mimeType ? event.data : new Blob([event.data], { type: mimeType })
        queue.enqueue(typed)
      })
      recorder.addEventListener('error', () => {
        if (epoch !== this.epoch) return
        this.publish({ ...this.viewState, phase: 'failed', message: REQUEST_FAILED_MESSAGE })
      })
      this.publish({
        ...idleView(),
        phase: 'recording',
        mimeType,
        browserSampleRate: null,
        recording: started,
        startedAtMs: this.options.clock.now(),
        canPause: typeof recorder.pause === 'function' && typeof recorder.resume === 'function',
        liveTranscriptUnavailable: true,
      })
      recorder.start(CHUNK_TIMESLICE_MS)
    } catch (error: unknown) {
      if (epoch !== this.epoch) return
      this.disposeMedia()
      this.publish({ ...idleView(), phase: 'failed', message: visibleError(error) })
    }
  }

  private async pauseNow(): Promise<void> {
    if (this.viewState.phase !== 'recording' && this.viewState.phase !== 'upload-error') return
    if (this.mode === 'pcm') {
      await this.pausePcm()
      return
    }
    this.pauseWebm()
  }

  private async pausePcm(): Promise<void> {
    if (!this.recordingId) return
    if (this.viewState.paused) {
      await this.resumePcm()
      return
    }
    this.capturePaused = true
    const tail = this.pcm?.pause() ?? new Uint8Array()
    this.enqueuePcm(tail)
    try {
      await this.waitForDrain()
      await this.waitForSocketIdle()
    } catch (error: unknown) {
      this.publish({ ...this.viewState, phase: 'upload-error', message: visibleError(error), audioSaved: this.acceptedFrames > 0 || this.viewState.audioSaved })
      return
    }
    try {
      if (this.socket?.isOpen()) this.socket.send(JSON.stringify({ type: 'session.pause' }))
      else await pauseRecording(this.recordingId, this.options.request)
    } catch (error: unknown) {
      this.capturePaused = false
      this.pcm?.resume()
      this.publish({ ...this.viewState, message: visibleError(error) })
      return
    }
    this.publish({
      ...this.viewState,
      paused: true,
      pausedAtMs: this.options.clock.now(),
      segments: confirmedSegments(this.viewState.segments),
    })
  }

  private async resumePcm(): Promise<void> {
    if (!this.recordingId) return
    const pausedAt = this.viewState.pausedAtMs ?? this.options.clock.now()
    const extra = Math.max(0, this.options.clock.now() - pausedAt)
    try {
      if (this.socket?.isOpen()) {
        const ready = this.waitFor('resume')
        this.socket.send(JSON.stringify({ type: 'session.resume' }))
        await ready
      } else {
        await resumeRecording(this.recordingId, this.options.request)
        await this.openSocket(this.recordingId, this.sampleRate)
      }
    } catch (error: unknown) {
      this.publish({ ...this.viewState, message: visibleError(error) })
      return
    }
    this.capturePaused = false
    this.pcm?.resume()
    this.publish({
      ...this.viewState,
      paused: false,
      pausedAtMs: null,
      pausedTotalMs: this.viewState.pausedTotalMs + extra,
      message: null,
    })
  }

  private pauseWebm(): void {
    const recorder = this.recorder
    if (!recorder?.pause || !recorder.resume) return
    if (this.viewState.paused) {
      const pausedAt = this.viewState.pausedAtMs ?? this.options.clock.now()
      const extra = Math.max(0, this.options.clock.now() - pausedAt)
      try {
        recorder.resume()
      } catch {
        return
      }
      this.publish({ ...this.viewState, paused: false, pausedAtMs: null, pausedTotalMs: this.viewState.pausedTotalMs + extra })
      return
    }
    try {
      recorder.pause()
    } catch {
      return
    }
    this.publish({ ...this.viewState, paused: true, pausedAtMs: this.options.clock.now() })
  }

  private async stopNow(): Promise<void> {
    const epoch = this.epoch
    const retryable = this.viewState.phase === 'failed' && this.viewState.audioSaved && Boolean(this.recordingId) && this.viewState.recording?.status !== 'ENDED'
    if (this.viewState.phase !== 'recording' && this.viewState.phase !== 'upload-error' && !retryable) return
    this.publish({ ...this.viewState, phase: 'finishing', message: null })
    if (this.mode === 'pcm') {
      await this.stopPcm(epoch)
      return
    }
    await this.stopWebm(epoch)
  }

  private async stopPcm(epoch: number): Promise<void> {
    this.capturePaused = true
    const tail = this.pcm ? await this.pcm.stop() : new Uint8Array()
    this.pcm = null
    this.enqueuePcm(tail)
    try {
      await this.waitForDrain()
      await this.waitForSocketIdle()
    } catch (error: unknown) {
      if (epoch !== this.epoch) return
      this.publish({ ...this.viewState, phase: 'upload-error', message: visibleError(error), audioSaved: this.acceptedFrames > 0 || this.viewState.audioSaved })
      return
    }
    if (epoch !== this.epoch) return
    this.disposeMedia()
    if (this.acceptedFrames === 0) {
      this.publish({ ...this.viewState, phase: 'failed', message: '录音没有可结束的音频' })
      return
    }
    await this.finishPcm(epoch)
  }

  private async finishPcm(epoch: number): Promise<void> {
    if (!this.recordingId) return
    if (this.socket?.isOpen()) {
      const completed = this.waitFor('completed')
      this.socket.send(JSON.stringify({ type: 'session.finish' }))
      try {
        await completed
        if (epoch !== this.epoch) return
        await this.beginProcessing(epoch, this.completedTask)
        return
      } catch (error: unknown) {
        if (epoch !== this.epoch) return
        try {
          await this.finishByRest(epoch)
        } catch (restError: unknown) {
          if (epoch !== this.epoch) return
          await this.recoverFinish(epoch, restError ?? error)
        }
      }
      return
    }
    try {
      await this.finishByRest(epoch)
    } catch (error: unknown) {
      if (epoch !== this.epoch) return
      await this.recoverFinish(epoch, error)
    }
  }

  private async finishByRest(epoch: number): Promise<void> {
    if (!this.recordingId) return
    const finished = await finishRecording(this.recordingId, this.options.request)
    if (epoch !== this.epoch) return
    this.publish({ ...this.viewState, phase: 'processing', recording: finished.recording, task: finished.task, audioSaved: true, message: null })
    this.poll(epoch, finished.task.id)
  }

  private async beginProcessing(epoch: number, task: RecordingTask | null): Promise<void> {
    if (!this.recordingId) return
    if (!task) {
      const detail = await fetchRecording(this.recordingId, this.options.request)
      if (epoch !== this.epoch) return
      if (!detail.task) throw new Error('录音结束任务缺失')
      this.publish({ ...this.viewState, phase: 'processing', recording: detail.recording, task: detail.task, audioSaved: true, message: null })
      this.poll(epoch, detail.task.id)
      return
    }
    const recording = this.viewState.recording ? { ...this.viewState.recording, status: 'ENDED' as const } : this.viewState.recording
    this.publish({ ...this.viewState, phase: 'processing', recording, task, audioSaved: true, message: null })
    this.poll(epoch, task.id)
  }

  private async recoverFinish(epoch: number, error: unknown): Promise<void> {
    if (!this.recordingId) return
    if (error instanceof ApiError && (error.code === 'INVALID_RECORDING_STATE' || error.code === 'TASK_ALREADY_RUNNING')) {
      try {
        const detail = await fetchRecording(this.recordingId, this.options.request)
        if (epoch !== this.epoch) return
        if (detail.recording.status === 'ENDED' && detail.task) {
          this.publish({ ...this.viewState, phase: 'processing', recording: detail.recording, task: detail.task, audioSaved: true, message: null })
          this.poll(epoch, detail.task.id)
          return
        }
      } catch {
        // The original finish error is more useful than a follow-up read failure.
      }
    }
    if (epoch !== this.epoch) return
    this.publish({ ...this.viewState, phase: 'failed', audioSaved: this.acceptedFrames > 0 || this.viewState.audioSaved, message: visibleError(error) })
  }

  private async stopWebm(epoch: number): Promise<void> {
    await this.stopRecorder()
    this.disposeMedia()
    if (epoch !== this.epoch) return
    try {
      await this.queue?.flush()
    } catch (error: unknown) {
      if (epoch !== this.epoch) return
      this.publish({ ...this.viewState, phase: 'upload-error', message: visibleError(error) })
      return
    }
    if (epoch !== this.epoch) return
    if (!this.recordingId || (this.queue?.savedCount ?? 0) === 0) {
      this.publish({ ...this.viewState, phase: 'failed', message: '录音没有可结束的音频' })
      return
    }
    try {
      await this.finishByRest(epoch)
    } catch (error: unknown) {
      if (epoch !== this.epoch) return
      this.publish({ ...this.viewState, phase: 'failed', audioSaved: (this.queue?.savedCount ?? 0) > 0, message: visibleError(error) })
    }
  }

  private enqueuePcm(pcm: Uint8Array): void {
    const even = pcm.byteLength % 2 === 0 ? pcm : pcm.subarray(0, pcm.byteLength - 1)
    if (even.byteLength === 0 || !this.recordingId || this.sampleRate <= 0) return
    const sequence = this.sequence
    this.sequence += 1
    const timestampMs = Math.round(this.samplesSent / this.sampleRate * 1000)
    this.samplesSent += even.byteLength / 2
    this.pending.push({ sequence, timestampMs, pcm: even })
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.pending.length > 0 && !this.halted) {
        const frame = this.pending[0]
        if (!frame) break
        await this.sendWithRetry(frame)
        this.pending.shift()
        this.acceptedFrames = frame.sequence + 1
        this.reconnects = 0
        if (this.boundEpoch === this.epoch) {
          this.publish({ ...this.viewState, savedChunks: this.acceptedFrames, audioSaved: true })
        }
      }
    } catch {
      // sendWithRetry already published the upload error and kept the frame queued.
    }
    this.pumping = false
    if (!this.halted && this.pending.length > 0) {
      void this.pump()
      return
    }
    this.resolveDrain()
  }

  private async sendWithRetry(frame: PendingFrame): Promise<void> {
    let attempts = 0
    while (attempts < 3) {
      try {
        await this.sendOnce(frame)
        return
      } catch (error: unknown) {
        attempts += 1
        this.lastError = error
      }
    }
    this.halted = true
    if (this.boundEpoch === this.epoch) {
      this.publish({
        ...this.viewState,
        phase: 'upload-error',
        message: visibleError(this.lastError),
        audioSaved: this.acceptedFrames > 0 || this.viewState.audioSaved,
      })
    }
    throw this.lastError instanceof Error ? this.lastError : new Error('音频分片上传失败')
  }

  private async sendOnce(frame: PendingFrame): Promise<void> {
    const socket = this.socket
    if (socket?.isOpen()) {
      socket.send(encodePcmFrame(frame.sequence, frame.timestampMs, frame.pcm))
      return
    }
    if (!this.recordingId) throw new Error('录音没有可结束的音频')
    const saved = await uploadRecordingChunk(
      this.recordingId,
      frame.sequence,
      new Blob([arrayBufferFrom(frame.pcm)], { type: 'audio/pcm' }),
      this.options.request,
      this.sampleRate,
    )
    if (saved.segments.length > 0 && this.boundEpoch === this.epoch) {
      this.publish({
        ...this.viewState,
        segments: mergeSegments(this.viewState.segments, saved.segments),
        liveTranscriptUnavailable: false,
      })
    }
  }

  private waitForDrain(): Promise<void> {
    if (!this.pumping && this.pending.length === 0 && !this.halted) return Promise.resolve()
    if (this.halted && !this.pumping) return Promise.reject(this.lastError ?? new Error('音频分片上传失败'))
    return new Promise((resolve, reject) => {
      this.drain = { resolve, reject }
    })
  }

  private resolveDrain(): void {
    const drain = this.drain
    if (!drain || this.pumping) return
    this.drain = null
    if (this.halted) drain.reject(this.lastError ?? new Error('音频分片上传失败'))
    else drain.resolve()
  }

  private async waitForSocketIdle(): Promise<void> {
    const socket = this.socket
    if (!socket?.isOpen()) return
    const started = Date.now()
    while (socket.bufferedAmount() > 0 && Date.now() - started < 5000) {
      await new Promise<void>((resolve) => {
        this.options.clock.setTimer(() => resolve(), 20)
      })
    }
  }

  private async openSocket(recordingId: string, sampleRate: number): Promise<boolean> {
    const generation = ++this.socketGeneration
    const previous = this.socket
    this.socket = null
    previous?.close()
    let socket: RecordingSocket
    try {
      socket = this.options.media.createSocket(recordingId)
    } catch {
      return false
    }
    this.socket = socket
    socket.onMessage((data) => {
      if (generation !== this.socketGeneration) return
      this.onSocketMessage(data)
    })
    socket.onClose(() => {
      if (generation !== this.socketGeneration) return
      void this.onSocketClose()
    })
    try {
      await socket.opened()
    } catch {
      return false
    }
    if (generation !== this.socketGeneration || this.boundEpoch !== this.epoch) return false
    const ready = this.waitFor('ready')
    socket.send(JSON.stringify({ type: 'session.start', sampleRate, channels: 1, encoding: 'pcm_s16le' }))
    try {
      await ready
      return generation === this.socketGeneration
    } catch {
      return false
    }
  }

  private async onSocketClose(): Promise<void> {
    if (this.viewState.phase === 'finishing') {
      this.failWaiter('completed')
      return
    }
    if (this.connecting || this.viewState.paused || this.viewState.phase !== 'recording' || !this.recordingId) return
    if (this.reconnects >= 2) {
      this.publish({ ...this.viewState, message: REQUEST_FAILED_MESSAGE })
      return
    }
    this.reconnects += 1
    this.connecting = true
    try {
      const ok = await this.openSocket(this.recordingId, this.sampleRate)
      if (!ok && this.boundEpoch === this.epoch) this.publish({ ...this.viewState, message: REQUEST_FAILED_MESSAGE })
    } finally {
      this.connecting = false
    }
  }

  private onSocketMessage(raw: string): void {
    const event = parseServerEvent(raw)
    if (!event || this.boundEpoch !== this.epoch) return
    if (event.type === 'session.ready') {
      this.signal('ready')
      return
    }
    if (event.type === 'transcript.partial' || event.type === 'transcript.final') {
      if (event.type === 'transcript.partial' && this.viewState.paused) return
      this.publish({
        ...this.viewState,
        segments: applyTranscriptEvent(this.recordingId ?? '', this.viewState.segments, event),
        liveTranscriptUnavailable: false,
      })
      return
    }
    if (event.type === 'asr.status') {
      this.onAsrStatus(event)
      return
    }
    if (event.type === 'asr.error') {
      if (this.viewState.phase === 'processing' || this.viewState.phase === 'done') return
      const unavailable = event.code === 'ASR_UNAVAILABLE'
      this.publish({
        ...this.viewState,
        message: unavailable ? LIVE_TRANSCRIPT_UNAVAILABLE_MESSAGE : event.message,
        liveTranscriptUnavailable: unavailable || this.viewState.liveTranscriptUnavailable,
        audioSaved: this.viewState.audioSaved || this.acceptedFrames > 0,
      })
      if (this.viewState.phase === 'finishing') this.failWaiter('completed')
      return
    }
    if (event.type === 'session.completed') {
      this.completedTask = parseRecordingTask(event.task)
      this.signal('completed')
    }
  }

  private onAsrStatus(event: Extract<ServerEvent, { type: 'asr.status' }>): void {
    if (event.status === 'ready') this.signal('resume')
    if (event.status === 'paused') {
      this.publish({
        ...this.viewState,
        paused: true,
        pausedAtMs: this.viewState.pausedAtMs ?? this.options.clock.now(),
        segments: confirmedSegments(this.viewState.segments),
      })
      this.signal('paused')
      return
    }
    if (event.status === 'unavailable') {
      this.liveUnavailable = true
      this.publish({
        ...this.viewState,
        liveTranscriptUnavailable: true,
        message: this.viewState.segments.length > 0 ? this.viewState.message : LIVE_TRANSCRIPT_UNAVAILABLE_MESSAGE,
        audioSaved: this.viewState.audioSaved || this.acceptedFrames > 0,
      })
    }
  }

  private waitFor(kind: string): Promise<void> {
    this.clearWaiter(kind, true)
    return new Promise((resolve, reject) => {
      const timer = this.options.clock.setTimer(() => {
        this.waiters.delete(kind)
        reject(new Error(kind))
      }, 10000)
      this.waiters.set(kind, { resolve, reject, timer })
    })
  }

  private signal(kind: string): void {
    const waiter = this.waiters.get(kind)
    if (!waiter) return
    this.waiters.delete(kind)
    this.options.clock.clearTimer(waiter.timer)
    waiter.resolve()
  }

  private failWaiter(kind: string): void {
    this.clearWaiter(kind, true)
  }

  private clearWaiter(kind: string, rejectIt: boolean): void {
    const waiter = this.waiters.get(kind)
    if (!waiter) return
    this.waiters.delete(kind)
    this.options.clock.clearTimer(waiter.timer)
    if (rejectIt) waiter.reject(new Error(kind))
  }

  private async sendChunk(epoch: number, recordingId: string, sequence: number, blob: Blob): Promise<{ segments: TranscriptSegment[]; asrStatus: AudioAsrStatus }> {
    const saved = await uploadRecordingChunk(recordingId, sequence, blob, this.options.request)
    if (epoch !== this.epoch) return { segments: [], asrStatus: saved.chunk.asrStatus }
    return { segments: [], asrStatus: saved.chunk.asrStatus }
  }

  private poll(epoch: number, taskId: string): void {
    this.stopPoll?.()
    const watched = watchRecordingTask(taskId, {
      getTask: (id) => fetchRecordingTask(id, this.options.request),
      setTimer: this.options.clock.setTimer,
      clearTimer: this.options.clock.clearTimer,
      isCurrent: () => epoch === this.epoch,
      onTask: (task) => {
        if (epoch !== this.epoch) return
        this.publish({ ...this.viewState, task })
        if (task.status === 'SUCCEEDED' || task.status === 'FAILED') void this.loadDetail(epoch, task)
      },
      onGiveUp: (message) => {
        if (epoch !== this.epoch) return
        this.publish({ ...this.viewState, phase: 'failed', audioSaved: this.viewState.audioSaved, message })
      },
    })
    this.stopPoll = watched.stop
  }

  private async loadDetail(epoch: number, task: RecordingTask): Promise<void> {
    if (!this.recordingId) return
    try {
      const detail = await fetchRecording(this.recordingId, this.options.request)
      if (epoch !== this.epoch) return
      this.publish(viewFromDetail(this.viewState, detail, task))
    } catch (error: unknown) {
      if (epoch !== this.epoch) return
      this.publish({
        ...this.viewState,
        phase: task.status === 'SUCCEEDED' ? 'done' : 'failed',
        task,
        audioSaved: this.viewState.audioSaved,
        message: task.status === 'FAILED' ? failureCopy(task) : visibleError(error),
      })
    }
  }

  private stopRecorder(): Promise<void> {
    const recorder = this.recorder
    this.recorder = null
    if (!recorder) return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      recorder.addEventListener('stop', finish)
      try {
        recorder.stop()
      } catch {
        finish()
      }
    })
  }

  private resetTransport(): void {
    this.mode = null
    this.queue = null
    this.recordingId = null
    this.pcm = null
    this.sampleRate = 0
    this.sequence = 0
    this.samplesSent = 0
    this.acceptedFrames = 0
    this.pending = []
    this.halted = false
    this.lastError = null
    this.capturePaused = false
    this.reconnects = 0
    this.completedTask = null
    this.liveUnavailable = false
    this.socketGeneration += 1
    this.socket?.close()
    this.socket = null
    void this.stopRecorder()
    this.disposeMedia()
  }

  private disposeMedia(): void {
    stopStream(this.stream)
    this.stream = null
  }

  private publish(view: RecordingView): void {
    if (this.boundEpoch !== this.epoch) return
    this.viewState = view
    this.options.onChange(view)
  }
}

function microphoneMessage(error: unknown): string {
  const name = errorName(error)
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') return MIC_PERMISSION_MESSAGE
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return MIC_MISSING_MESSAGE
  if (name === 'NotReadableError' || name === 'TrackStartError') return MIC_BUSY_MESSAGE
  if (name === 'TypeError') return RECORDER_UNSUPPORTED_MESSAGE
  return REQUEST_FAILED_MESSAGE
}

function stopStream(stream: MediaStreamLike | null): void {
  stream?.getTracks().forEach((track) => track.stop())
}

function failureCopy(task: RecordingTask): string {
  if (task.errorCode === 'ASR_UNAVAILABLE' || task.errorCode === 'ASR_FAILED') return PROCESS_UNAVAILABLE_MESSAGE
  return task.errorMessage?.trim() || REQUEST_FAILED_MESSAGE
}

function viewFromDetail(current: RecordingView, detail: RecordingDetail, task: RecordingTask): RecordingView {
  const audioSaved = detail.chunks.length > 0 || current.audioSaved
  return {
    ...current,
    phase: task.status === 'SUCCEEDED' ? 'done' : 'failed',
    recording: detail.recording,
    segments: detail.segments,
    knowledgePoints: task.status === 'SUCCEEDED' ? detail.knowledgePoints : [],
    task,
    audioSaved,
    savedChunks: Math.max(current.savedChunks, detail.chunks.length),
    liveTranscriptUnavailable: detail.segments.length === 0,
    message: task.status === 'FAILED' ? failureCopy(task) : null,
  }
}
