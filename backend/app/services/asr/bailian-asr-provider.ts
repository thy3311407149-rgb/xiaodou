import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { logger } from '../../core/logger.js'
import { ApplicationError } from '../../core/errors/application-error.js'
import { buildFinishTaskMessage, buildRunTaskMessage, readServerError, readServerEventName, readTranscriptUpdates } from './bailian-protocol.js'
import type { AsrProvider, AsrSession, AsrSessionOptions, AsrStreamEvent, AsrTranscriptSegment } from './asr-provider.js'

export type BailianAsrOptions = {
  apiKey: string
  model: string
  wsUrl: string
  timeoutMs?: number
}

export class UnconfiguredAsrProvider implements AsrProvider {
  readonly name = 'unconfigured'

  isConfigured(): boolean {
    return false
  }

  async openSession(_options: AsrSessionOptions): Promise<AsrSession> {
    throw new ApplicationError('ASR_UNAVAILABLE')
  }
}

export class BailianAsrProvider implements AsrProvider {
  readonly name = 'bailian-paraformer-realtime'

  constructor(private readonly options: BailianAsrOptions) {}

  isConfigured(): boolean {
    return this.options.apiKey.trim().length > 0
  }

  async openSession(sessionOptions: AsrSessionOptions): Promise<AsrSession> {
    if (!this.isConfigured()) throw new ApplicationError('ASR_UNAVAILABLE')
    const session = new BailianAsrSession(this.options, sessionOptions)
    await session.open()
    return session
  }
}

class BailianAsrSession implements AsrSession {
  private readonly taskId = randomUUID()
  private readonly socket: WebSocket
  private readonly pending: AsrTranscriptSegment[] = []
  private listener: ((event: AsrStreamEvent) => void) | null = null
  private failure: ApplicationError | null = null
  private audioFrames = 0
  private audioBytes = 0
  private partials = 0
  private finals = 0
  private opened = false

  constructor(
    private readonly options: BailianAsrOptions,
    private readonly sessionOptions: AsrSessionOptions,
  ) {
    this.socket = new WebSocket(options.wsUrl, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
    })
    this.socket.on('message', (data, isBinary) => {
      const raw = rawMessage(data)
      if (isBinary && !raw.trimStart().startsWith('{')) return
      this.consume(raw)
    })
    this.socket.on('close', (code, reason) => {
      logger.info('ASR_SOCKET_CLOSED', { taskId: this.taskId, closeCode: code, reason: reason.toString() })
    })
    this.socket.on('error', () => {
      logger.error('ASR_SOCKET_ERROR', { taskId: this.taskId })
    })
  }

  get sessionId(): string {
    return this.taskId
  }

  async open(): Promise<void> {
    await waitForOpen(this.socket, this.options.timeoutMs ?? 15_000)
    this.socket.send(buildRunTaskMessage({
      taskId: this.taskId,
      model: this.options.model,
      format: this.sessionOptions.format,
      sampleRate: this.sessionOptions.sampleRate,
    }))
    await this.waitFor(['task-started'])
    this.opened = true
    logger.info('ASR_SESSION_READY', { taskId: this.taskId, format: this.sessionOptions.format, sampleRate: this.sessionOptions.sampleRate })
  }

  setListener(listener: ((event: AsrStreamEvent) => void) | null): void {
    this.listener = listener
  }

  async pushAudio(audio: Buffer): Promise<AsrTranscriptSegment[]> {
    if (!this.opened) throw new ApplicationError('ASR_FAILED', { message: '语音识别会话尚未开始' })
    if (this.failure) throw this.failure
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new ApplicationError('ASR_FAILED', { message: '语音识别连接已关闭' })
    }
    const payload = Buffer.from(audio)
    this.socket.send(payload)
    this.audioFrames += 1
    this.audioBytes += payload.length
    logger.info('ASR_AUDIO_SENT', { taskId: this.taskId, frames: this.audioFrames, bytes: this.audioBytes, frameBytes: payload.length })
    await delay(0)
    if (this.failure) throw this.failure
    return this.drain()
  }

  async finish(): Promise<AsrTranscriptSegment[]> {
    if (!this.opened) return []
    logger.info('ASR_FINISH_SENT', { taskId: this.taskId, frames: this.audioFrames, bytes: this.audioBytes, partials: this.partials, providerFinals: this.finals })
    try {
      if (this.socket.readyState === WebSocket.OPEN) this.socket.send(buildFinishTaskMessage(this.taskId))
      await this.waitFor(['task-finished'], 8_000)
    } catch (error: unknown) {
      const recognized = this.drain()
      this.closeSocket()
      logger.error('ASR_FINISH_FAILED', {
        taskId: this.taskId,
        errorMessage: error instanceof Error ? error.message : '语音识别结束失败',
        pendingFinals: recognized.length,
        partials: this.partials,
        providerFinals: this.finals,
      })
      if (recognized.length > 0) return recognized
      throw error
    }
    const recognized = this.drain()
    logger.info('ASR_FINISH_COMPLETED', { taskId: this.taskId, finals: recognized.length, partials: this.partials, providerFinals: this.finals })
    this.closeSocket()
    return recognized
  }

  private consume(raw: string): void {
    let message: unknown
    try {
      message = JSON.parse(raw) as unknown
    } catch {
      return
    }
    const eventName = readServerEventName(message)
    const failure = readServerError(message)
    if (failure) {
      this.failure = new ApplicationError('ASR_FAILED', { message: failure })
      logger.error('ASR_SERVER_EVENT', { taskId: this.taskId, event: eventName ?? 'task-failed', errorMessage: failure })
      return
    }
    const updates = readTranscriptUpdates(message)
    if (updates.length === 0) {
      logger.info('ASR_SERVER_EVENT', { taskId: this.taskId, event: eventName ?? 'unknown', kind: null })
      return
    }
    for (const update of updates) {
      const count = this.count(update.kind)
      logger.info('ASR_SERVER_EVENT', {
        taskId: this.taskId,
        event: eventName ?? 'result-generated',
        kind: update.kind,
        textLength: update.segment.text.length,
        partials: update.kind === 'partial' ? count : this.partials,
        finals: update.kind === 'final' ? count : this.finals,
      })
      if (update.kind === 'final') this.pending.push(update.segment)
      try {
        this.listener?.({ type: update.kind === 'final' ? 'final' : 'partial', segment: update.segment })
      } catch (error: unknown) {
        logger.error('ASR_LISTENER_FAILED', {
          taskId: this.taskId,
          kind: update.kind,
          errorMessage: error instanceof Error ? error.message : 'listener failed',
        })
      }
    }
  }

  private count(kind: 'partial' | 'final'): number {
    if (kind === 'partial') {
      this.partials += 1
      return this.partials
    }
    this.finals += 1
    return this.finals
  }

  private drain(): AsrTranscriptSegment[] {
    return this.pending.splice(0, this.pending.length)
  }

  private closeSocket(): void {
    this.opened = false
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close()
    }
  }

  private waitFor(events: readonly string[], timeoutMs = this.options.timeoutMs ?? 15_000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket.readyState === WebSocket.CLOSED) {
        reject(new ApplicationError('ASR_FAILED', { message: '语音识别连接已关闭' }))
        return
      }
      const timeout = setTimeout(() => {
        cleanup()
        reject(new ApplicationError('ASR_FAILED', { message: '语音识别服务响应超时' }))
      }, timeoutMs)
      const onMessage = (data: WebSocket.RawData) => {
        let message: unknown
        try {
          message = JSON.parse(rawMessage(data)) as unknown
        } catch {
          return
        }
        const name = readServerEventName(message)
        const failure = readServerError(message)
        if (failure) {
          cleanup()
          reject(new ApplicationError('ASR_FAILED', { message: failure }))
          return
        }
        if (name && events.includes(name)) {
          cleanup()
          resolve()
        }
      }
      const onClose = (code: number) => {
        cleanup()
        reject(new ApplicationError('ASR_FAILED', { message: `语音识别连接已关闭（${code}）` }))
      }
      const onError = () => {
        cleanup()
        reject(new ApplicationError('ASR_FAILED'))
      }
      const cleanup = () => {
        clearTimeout(timeout)
        this.socket.off('message', onMessage)
        this.socket.off('close', onClose)
        this.socket.off('error', onError)
      }
      this.socket.on('message', onMessage)
      this.socket.on('close', onClose)
      this.socket.on('error', onError)
    })
  }
}

function waitForOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new ApplicationError('ASR_FAILED', { message: '语音识别服务连接超时' }))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timeout)
      socket.off('open', onOpen)
      socket.off('error', onError)
    }
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new ApplicationError('ASR_FAILED'))
    }
    socket.on('open', onOpen)
    socket.on('error', onError)
  })
}

function rawMessage(data: WebSocket.RawData): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
