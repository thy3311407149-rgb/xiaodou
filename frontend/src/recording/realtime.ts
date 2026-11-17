import type { TranscriptSegment } from '../api/recordings.ts'

export const PCM_FRAME_MS = 100

export type PcmSource = {
  sampleRate: number
  start: (onFrame: (pcm: Uint8Array) => void) => void
  pause: () => Uint8Array
  resume: () => void
  stop: () => Promise<Uint8Array>
}

export type RecordingSocket = {
  isOpen: () => boolean
  bufferedAmount: () => number
  send: (data: string | ArrayBuffer) => void
  close: () => void
  onMessage: (listener: (data: string) => void) => void
  onClose: (listener: () => void) => void
  opened: () => Promise<void>
}

export type TranscriptEvent = {
  type: 'transcript.partial' | 'transcript.final'
  segmentId: string
  id?: string
  text: string
  beginTime: number
  endTime: number
  speakerId: string | null
  isFinal: boolean
  sequence: number
}

export type AsrStatusName = 'ready' | 'paused' | 'unavailable' | 'finishing'

export type ServerEvent =
  | { type: 'session.ready'; recordingId: string; format: string; sampleRate: number; channels: number; encoding: string }
  | ({ type: 'transcript.partial' | 'transcript.final' } & TranscriptEvent)
  | { type: 'asr.status'; status: AsrStatusName }
  | { type: 'asr.error'; code: string; message: string }
  | { type: 'session.completed'; recordingId: string; task: unknown }

export function recordingStreamUrl(recordingId: string, page: { protocol: string; host: string }): string {
  const wsProtocol = page.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${wsProtocol}//${page.host}/api/recordings/${encodeURIComponent(recordingId)}/stream`
}

export function frameSampleCount(sampleRate: number): number {
  return Math.max(1, Math.round(sampleRate * PCM_FRAME_MS / 1000))
}

export function floatToPcm16(samples: Float32Array): Uint8Array {
  const pcm = new Int16Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0))
    pcm[index] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767)
  }
  return new Uint8Array(pcm.buffer)
}

export function encodePcmFrame(sequence: number, timestampMs: number, pcm: Uint8Array): ArrayBuffer {
  const frame = new ArrayBuffer(8 + pcm.byteLength)
  const view = new DataView(frame)
  view.setUint32(0, sequence, true)
  view.setUint32(4, Math.max(0, timestampMs), true)
  new Uint8Array(frame).set(pcm, 8)
  return frame
}

export function pcmToWav(pcm: Uint8Array, sampleRate: number): Blob {
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  view.setUint32(0, 0x46464952, true)
  view.setUint32(4, 36 + pcm.byteLength, true)
  view.setUint32(8, 0x45564157, true)
  view.setUint32(12, 0x20746d66, true)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  view.setUint32(36, 0x61746164, true)
  view.setUint32(40, pcm.byteLength, true)
  return new Blob([header, arrayBufferFrom(pcm)], { type: 'audio/wav' })
}

export function arrayBufferFrom(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

export class SampleBuffer {
  private readonly parts: Uint8Array[] = []
  private bytes = 0
  private readonly frameBytes: number

  constructor(frameSamples: number) {
    this.frameBytes = Math.max(1, frameSamples) * 2
  }

  push(pcm: Uint8Array): Uint8Array[] {
    if (pcm.byteLength === 0) return []
    this.parts.push(pcm)
    this.bytes += pcm.byteLength
    const frames: Uint8Array[] = []
    while (this.bytes >= this.frameBytes) frames.push(this.take(this.frameBytes))
    return frames
  }

  flush(): Uint8Array {
    if (this.bytes === 0) return new Uint8Array()
    return this.take(this.bytes)
  }

  private take(size: number): Uint8Array {
    const out = new Uint8Array(size)
    let filled = 0
    while (filled < size && this.parts.length > 0) {
      const part = this.parts[0]
      if (!part) break
      const need = size - filled
      if (part.byteLength <= need) {
        out.set(part, filled)
        filled += part.byteLength
        this.parts.shift()
      } else {
        out.set(part.subarray(0, need), filled)
        this.parts[0] = part.subarray(need)
        filled += need
      }
    }
    this.bytes -= size
    return out
  }
}

export function parseServerEvent(raw: string): ServerEvent | null {
  let body: unknown
  try {
    body = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (!isRecord(body) || typeof body.type !== 'string') return null
  if (body.type === 'session.ready') {
    if (typeof body.recordingId !== 'string' || typeof body.sampleRate !== 'number') return null
    return {
      type: 'session.ready',
      recordingId: body.recordingId,
      format: typeof body.format === 'string' ? body.format : 'pcm',
      sampleRate: body.sampleRate,
      channels: typeof body.channels === 'number' ? body.channels : 1,
      encoding: typeof body.encoding === 'string' ? body.encoding : 'pcm_s16le',
    }
  }
  if (body.type === 'transcript.partial' || body.type === 'transcript.final') {
    const event = parseTranscript(body, body.type)
    return event ? { ...event, type: body.type } : null
  }
  if (body.type === 'asr.status') {
    if (body.status !== 'ready' && body.status !== 'paused' && body.status !== 'unavailable' && body.status !== 'finishing') return null
    return { type: 'asr.status', status: body.status }
  }
  if (body.type === 'asr.error') {
    if (typeof body.code !== 'string' || typeof body.message !== 'string') return null
    return { type: 'asr.error', code: body.code, message: body.message }
  }
  if (body.type === 'session.completed') {
    if (typeof body.recordingId !== 'string') return null
    return { type: 'session.completed', recordingId: body.recordingId, task: body.task }
  }
  return null
}

export function applyTranscriptEvent(recordingId: string, segments: TranscriptSegment[], event: TranscriptEvent): TranscriptSegment[] {
  if (!event.text.trim()) return segments
  const id = event.isFinal
    ? (event.id && event.id !== event.segmentId ? event.id : `saved:${event.beginTime}:${event.endTime}`)
    : event.segmentId
  const next: TranscriptSegment = {
    id,
    recordingId,
    segmentIndex: 0,
    audioSequence: event.sequence,
    content: event.text,
    startTimeMs: event.beginTime,
    endTimeMs: event.endTime,
    speakerId: event.speakerId,
    createdAt: '',
  }
  if (!event.isFinal) {
    const index = segments.findIndex((segment) => segment.id === event.segmentId)
    const updated = index >= 0
      ? segments.map((segment, position) => (position === index ? { ...segment, ...next, id: event.segmentId } : segment))
      : [...segments, next]
    return orderSegments(updated)
  }
  const partialId = `partial:${event.beginTime}`
  const kept = segments.filter((segment) => segment.id !== event.segmentId && segment.id !== id && segment.id !== partialId)
  return orderSegments([...kept, next])
}

export function confirmedSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  return orderSegments(segments.filter((segment) => !segment.id.startsWith('partial:')))
}

export function connectRecordingSocket(url: string, webSocket: WebSocket = new WebSocket(url)): RecordingSocket {
  let onMessage: (data: string) => void = () => undefined
  let onClose: () => void = () => undefined
  let opened = false
  let failed = false
  const ready = new Promise<void>((resolve, reject) => {
    webSocket.addEventListener('open', () => {
      opened = true
      resolve()
    })
    webSocket.addEventListener('error', () => {
      if (opened) return
      failed = true
      reject(new Error('实时转写连接失败'))
    })
  })
  webSocket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') onMessage(event.data)
  })
  webSocket.addEventListener('close', () => onClose())
  return {
    isOpen: () => webSocket.readyState === WebSocket.OPEN,
    bufferedAmount: () => webSocket.bufferedAmount,
    send: (data) => webSocket.send(data),
    close: () => webSocket.close(),
    onMessage: (listener) => {
      onMessage = listener
    },
    onClose: (listener) => {
      onClose = listener
    },
    opened: () => (failed ? Promise.reject(new Error('实时转写连接失败')) : ready),
  }
}

function orderSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  return [...segments]
    .sort((left, right) => left.startTimeMs - right.startTimeMs || left.endTimeMs - right.endTimeMs)
    .map((segment, index) => ({ ...segment, segmentIndex: index }))
}

function parseTranscript(body: Record<string, unknown>, type: 'transcript.partial' | 'transcript.final'): TranscriptEvent | null {
  if (typeof body.segmentId !== 'string' || typeof body.text !== 'string') return null
  if (typeof body.beginTime !== 'number' || typeof body.endTime !== 'number' || typeof body.sequence !== 'number') return null
  const isFinal = type === 'transcript.final' || body.isFinal === true
  return {
    type,
    segmentId: body.segmentId,
    id: typeof body.id === 'string' ? body.id : undefined,
    text: body.text,
    beginTime: body.beginTime,
    endTime: body.endTime,
    speakerId: typeof body.speakerId === 'string' ? body.speakerId : null,
    isFinal,
    sequence: body.sequence,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
