import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { ApplicationError } from '../core/errors/application-error.js'
import { logger } from '../core/logger.js'
import type { RecordingNotice, RecordingService } from '../services/recording-service.js'

const sockets = new Map<string, WebSocket>()

export function attachRecordingStreams(server: { on(event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): void }, service: RecordingService): void {
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    const recordingId = recordingIdFrom(request.url ?? '')
    if (!recordingId) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const previous = sockets.get(recordingId)
      if (previous && previous.readyState === WebSocket.OPEN) previous.close(4000, 'replaced')
      sockets.set(recordingId, ws)
      logger.info('RECORDING_WS_OPEN', { recordingId })
      service.bindNotice(recordingId, (event) => {
        if (sockets.get(recordingId) === ws) send(ws, recordingId, event)
      })
      ws.on('message', (data, isBinary) => {
        void handleMessage(ws, service, recordingId, data, isBinary).catch((error: unknown) => {
          send(ws, recordingId, errorNotice(error))
        })
      })
      ws.on('close', (code, reason) => {
        logger.info('RECORDING_WS_CLOSED', { recordingId, closeCode: code, reason: reason.toString() })
        if (sockets.get(recordingId) === ws) {
          sockets.delete(recordingId)
          service.bindNotice(recordingId, null)
        }
      })
    })
  })
}

async function handleMessage(ws: WebSocket, service: RecordingService, recordingId: string, data: RawData, isBinary: boolean): Promise<void> {
  if (isBinary) {
    const payload = Buffer.from(data as Buffer)
    if (payload.length < 8) throw new ApplicationError('INVALID_REQUEST', { message: '音频帧缺少序号' })
    const sequence = payload.readUInt32LE(0)
    logger.info('RECORDING_WS_FRAME', { recordingId, sequence, bytes: payload.length - 8, binary: true })
    await service.appendChunk(recordingId, {
      sequence,
      audio: payload.subarray(8),
      mimeType: 'audio/pcm',
      sampleRate: undefined,
    })
    return
  }
  const message = JSON.parse(data.toString()) as { type?: string; sampleRate?: number; channels?: number; encoding?: string; sequence?: number; audioBase64?: string }
  if (message.type === 'session.start') {
    if (message.channels !== 1 || message.encoding !== 'pcm_s16le') {
      throw new ApplicationError('INVALID_REQUEST', { message: '实时转写只接受单声道 16-bit PCM' })
    }
    await service.openPcmStream(recordingId, Number(message.sampleRate))
    return
  }
  if (message.type === 'audio.frame') {
    const audio = Buffer.from(message.audioBase64 ?? '', 'base64')
    logger.info('RECORDING_WS_FRAME', { recordingId, sequence: Number(message.sequence), bytes: audio.length, binary: false })
    await service.appendChunk(recordingId, {
      sequence: Number(message.sequence),
      audio,
      mimeType: 'audio/pcm',
    })
    return
  }
  if (message.type === 'session.pause') {
    await service.pause(recordingId)
    return
  }
  if (message.type === 'session.resume') {
    await service.resume(recordingId)
    return
  }
  if (message.type === 'session.finish') {
    await service.finish(recordingId, `recording-${recordingId}`)
    await flushSocket(ws)
    if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'completed')
    return
  }
  throw new ApplicationError('INVALID_REQUEST', { message: '无法识别的实时转写消息' })
}

function recordingIdFrom(rawUrl: string): string | null {
  const path = rawUrl.split('?')[0] ?? ''
  const match = path.match(/^\/api\/recordings\/([^/]+)\/stream$/)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

function send(ws: WebSocket, recordingId: string, event: RecordingNotice | { type: 'asr.error'; code: string; message: string }): void {
  if (ws.readyState !== WebSocket.OPEN) {
    logger.warn('RECORDING_WS_SEND_SKIPPED', { recordingId, type: event.type, readyState: ws.readyState })
    return
  }
  ws.send(JSON.stringify(event), (error) => {
    if (error) logger.error('RECORDING_WS_SEND_FAILED', { recordingId, type: event.type, errorMessage: error.message })
    else logger.info('RECORDING_WS_SENT', { recordingId, type: event.type })
  })
}

function flushSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount === 0) return Promise.resolve()
  return new Promise((resolve) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (ws.bufferedAmount === 0 || ws.readyState !== WebSocket.OPEN || Date.now() - started > 1_000) {
        clearInterval(timer)
        resolve()
      }
    }, 10)
  })
}

function errorNotice(error: unknown): { type: 'asr.error'; code: string; message: string } {
  if (error instanceof ApplicationError) return { type: 'asr.error', code: error.code, message: error.message }
  return { type: 'asr.error', code: 'ASR_FAILED', message: '语音识别失败' }
}
