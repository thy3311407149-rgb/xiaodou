import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/http.ts'
import type { HttpRequest } from '../api/http.ts'
import type { RecordingSocket } from './realtime.ts'
import {
  LIVE_TRANSCRIPT_UNAVAILABLE_MESSAGE,
  MIC_PERMISSION_MESSAGE,
  MIME_UNSUPPORTED_MESSAGE,
  PROCESS_UNAVAILABLE_MESSAGE,
  RECORDER_UNSUPPORTED_MESSAGE,
  RecordingSession,
  type RecorderHandle,
  type RecordingClock,
  type RecordingMedia,
  type RecordingView,
} from './session.ts'

const recordingBody = {
  id: 'rec_1',
  title: '录音',
  status: 'RECORDING',
  mimeType: 'audio/webm;codecs=opus',
  sampleRate: 16000,
  startedAt: '2026-11-04T00:00:00.000Z',
  endedAt: null,
  interruptedAt: null,
  errorCode: null,
  errorMessage: null,
  createdAt: '2026-11-04T00:00:00.000Z',
  updatedAt: '2026-11-04T00:00:00.000Z',
}

class FakeRecorder implements RecorderHandle {
  start = vi.fn()
  private listeners: Record<string, Array<(event: { data?: Blob }) => void>> = {}

  stop = vi.fn(() => {
    this.emit('dataavailable', { data: new Blob(['tail'], { type: 'audio/webm;codecs=opus' }) })
    this.emit('stop', {})
  })

  addEventListener(type: 'dataavailable' | 'stop' | 'error', listener: (event: { data?: Blob }) => void) {
    this.listeners[type] ??= []
    this.listeners[type].push(listener)
  }

  emit(type: 'dataavailable' | 'stop' | 'error', event: { data?: Blob }) {
    for (const listener of this.listeners[type] ?? []) listener(event)
  }
}

function clock(): RecordingClock {
  return {
    now: () => 5_000,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (id) => clearTimeout(id),
  }
}

function json(status: number, body: unknown) {
  return { status, body }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('recording session', () => {
  it('stops when the microphone permission is denied', async () => {
    const session = createSession({
      media: media({
        getUserMedia: async () => {
          throw new DOMException('denied', 'NotAllowedError')
        },
      }),
    })
    await session.start()
    expect(session.view.phase).toBe('failed')
    expect(session.view.message).toBe(MIC_PERMISSION_MESSAGE)
  })

  it('reports an unsupported recorder without requesting the microphone', async () => {
    const getUserMedia = vi.fn()
    const session = createSession({ media: media({ recorderAvailable: false, getUserMedia }) })
    await session.start()
    expect(session.view.message).toBe(RECORDER_UNSUPPORTED_MESSAGE)
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('reports an incompatible mime without requesting the microphone', async () => {
    const getUserMedia = vi.fn()
    const session = createSession({
      media: media({ isTypeSupported: () => false, getUserMedia }),
    })
    await session.start()
    expect(session.view.message).toBe(MIME_UNSUPPORTED_MESSAGE)
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('uploads chunks serially, keeps the last stop chunk, and finishes only after they succeed', async () => {
    const recorder = new FakeRecorder()
    const sequences: string[] = []
    const calls: string[] = []
    const session = createSession({
      media: media({ createRecorder: () => recorder }),
      request: async (path, init) => {
        calls.push(`${init?.method ?? 'GET'} ${path}`)
        if (path === '/api/recordings' && init?.method === 'POST') {
          return json(201, { data: { recording: { ...recordingBody, status: 'CREATED' }, knowledgeItemId: 'item_1' } })
        }
        if (path.endsWith('/start')) return json(200, { data: { recording: recordingBody } })
        if (path.endsWith('/chunks')) {
          const form = init?.body as FormData
          const sequence = String(form.get('sequence'))
          sequences.push(sequence)
          if (sequence === '0' && sequences.filter((item) => item === '0').length <= 3) throw new ApiError('网络中断', 0)
          return json(201, chunkResponse(Number(form.get('sequence')), 'SKIPPED'))
        }
        if (path.endsWith('/finish')) {
          return json(200, { data: { recording: { ...recordingBody, status: 'ENDED' }, task: taskBody('QUEUED') } })
        }
        if (path.startsWith('/api/tasks/')) return json(200, { data: { task: taskBody('FAILED', 'ASR_UNAVAILABLE') } })
        if (path === '/api/recordings/rec_1') {
          return json(200, {
            data: {
              recording: { ...recordingBody, status: 'ENDED', errorCode: 'ASR_UNAVAILABLE', errorMessage: '语音识别服务未配置' },
              knowledgeItemId: 'item_1',
              chunks: [{ id: 'chunk_1', recordingId: 'rec_1', sequence: 0, byteSize: 4, sha256: 'abc', mimeType: 'audio/webm;codecs=opus', asrStatus: 'SKIPPED', createdAt: recordingBody.createdAt }],
              segments: [],
              knowledgePoints: [{ id: 'kp_1', knowledgeItemId: 'item_1', recordingId: 'rec_1', sourceSegmentId: null, content: '不该在失败时展示', startTimeMs: null, endTimeMs: null, speakerId: null, createdAt: recordingBody.createdAt }],
              task: taskBody('FAILED', 'ASR_UNAVAILABLE'),
            },
          })
        }
        throw new ApiError('请求失败', 500)
      },
    })
    await session.start()
    recorder.emit('dataavailable', { data: new Blob(['live'], { type: 'audio/webm;codecs=opus' }) })
    await session.stop()
    expect(session.view.phase).toBe('upload-error')
    expect(calls.some((call) => call.includes('/finish'))).toBe(false)
    expect(sequences).toEqual(['0', '0', '0'])
    session.retryUpload()
    await session.stop()
    expect(sequences).toEqual(['0', '0', '0', '0', '1'])
    expect(calls.filter((call) => call.includes('/finish'))).toHaveLength(1)
    await vi.waitFor(() => expect(session.view.phase).toBe('failed'))
    expect(session.view.audioSaved).toBe(true)
    expect(session.view.segments).toEqual([])
    expect(session.view.knowledgePoints).toEqual([])
    expect(session.view.message).toBe(PROCESS_UNAVAILABLE_MESSAGE)
    expect(JSON.stringify(session.view)).not.toContain('不该在失败时展示')
  })

  it('keeps a webm upload as stored audio and does not show its response as the transcript', async () => {
    const recorder = new FakeRecorder()
    const session = createSession({
      media: media({ createRecorder: () => recorder }),
      request: async (path, init) => {
        if (path === '/api/recordings' && init?.method === 'POST') {
          return json(201, { data: { recording: { ...recordingBody, status: 'CREATED' }, knowledgeItemId: 'item_1' } })
        }
        if (path.endsWith('/start')) return json(200, { data: { recording: recordingBody } })
        if (path.endsWith('/chunks')) {
          return json(201, {
            data: {
              chunk: chunkResponse(0, 'SKIPPED').data.chunk,
              segments: [{
                id: 'seg_webm',
                recordingId: 'rec_1',
                segmentIndex: 0,
                audioSequence: 0,
                content: '不该从 WebM 上传里显示',
                startTimeMs: 0,
                endTimeMs: 1000,
                speakerId: null,
                createdAt: recordingBody.createdAt,
              }],
            },
          })
        }
        throw new ApiError('请求失败', 500)
      },
    })
    await session.start()
    recorder.emit('dataavailable', { data: new Blob(['live'], { type: 'audio/webm;codecs=opus' }) })
    await vi.waitFor(() => expect(session.view.audioSaved).toBe(true))
    expect(session.view.liveTranscriptUnavailable).toBe(true)
    expect(session.view.segments).toEqual([])
    expect(JSON.stringify(session.view)).not.toContain('不该从 WebM 上传里显示')
    session.dispose()
  })

  it('does not open a recording when dispose happens before the microphone request', async () => {
    const request = vi.fn(async () => json(500, null))
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }))
    const session = createSession({ request, media: media({ getUserMedia }) })
    const pending = session.start()
    session.dispose()
    await pending
    expect(request).not.toHaveBeenCalled()
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('releases the microphone and ignores a stale start after dispose', async () => {
    const stop = vi.fn()
    const pendingMedia: { resolve: (stream: { getTracks: () => Array<{ stop: () => void }> }) => void } = {
      resolve: () => undefined,
    }
    const session = createSession({
      media: media({
        getUserMedia: () => new Promise((resolve) => { pendingMedia.resolve = resolve }),
      }),
    })
    const pending = session.start()
    await Promise.resolve()
    session.dispose()
    pendingMedia.resolve({ getTracks: () => [{ stop }] })
    await pending
    expect(stop).toHaveBeenCalled()
    expect(session.view.phase).not.toBe('recording')
  })

  it('streams pcm frames in order, replaces partials, and finishes only after the tail frame', async () => {
    const source = new FakePcm()
    const socket = new FakeSocket()
    const calls: string[] = []
    const session = createSession({
      media: media({
        pcmAvailable: true,
        createPcmSource: async () => source,
        createSocket: () => socket,
      }),
      request: async (path, init) => {
        calls.push(`${init?.method ?? 'GET'} ${path}`)
        if (path === '/api/recordings' && init?.method === 'POST') {
          return json(201, { data: { recording: { ...recordingBody, status: 'CREATED', mimeType: null, sampleRate: null }, knowledgeItemId: 'item_1' } })
        }
        if (path.endsWith('/start')) return json(200, { data: { recording: { ...recordingBody, mimeType: null, sampleRate: null } } })
        if (path.endsWith('/finish')) return json(200, { data: { recording: { ...recordingBody, status: 'ENDED' }, task: taskBody('QUEUED') } })
        throw new ApiError('请求失败', 500)
      },
    })
    const pending = session.start()
    await vi.waitFor(() => expect(socket.texts().some((item) => item.includes('session.start'))).toBe(true))
    const started = JSON.parse(socket.texts().find((item) => item.includes('session.start')) ?? '{}') as { sampleRate?: number; channels?: number; encoding?: string }
    expect(started).toMatchObject({ sampleRate: 48000, channels: 1, encoding: 'pcm_s16le' })
    expect(JSON.stringify(started)).not.toContain('dashscope')
    socket.emit(JSON.stringify({ type: 'session.ready', recordingId: 'rec_1', format: 'pcm', sampleRate: 48000, channels: 1, encoding: 'pcm_s16le' }))
    await pending
    expect(session.view.phase).toBe('recording')
    expect(session.view.browserSampleRate).toBe(48000)

    source.push(new Uint8Array(9600))
    await vi.waitFor(() => expect(socket.frames()).toHaveLength(1))
    socket.emit(JSON.stringify({ type: 'transcript.partial', segmentId: 'partial:0', text: '你', beginTime: 0, endTime: 200, speakerId: null, isFinal: false, sequence: 0 }))
    socket.emit(JSON.stringify({ type: 'transcript.partial', segmentId: 'partial:0', text: '你好', beginTime: 0, endTime: 400, speakerId: null, isFinal: false, sequence: 0 }))
    expect(session.view.segments.map((segment) => segment.content)).toEqual(['你好'])
    expect(session.view.segments).toHaveLength(1)

    const stopping = session.stop()
    await vi.waitFor(() => expect(socket.texts().some((item) => item.includes('session.finish'))).toBe(true))
    const finishAt = socket.sent.findIndex((item) => typeof item === 'string' && item.includes('session.finish'))
    const frames = socket.sent.slice(0, finishAt).filter((item): item is ArrayBuffer => item instanceof ArrayBuffer)
    expect(frames.map((frame) => new DataView(frame).getUint32(0, true))).toEqual([0, 1])
    expect(new DataView(frames[1] ?? new ArrayBuffer()).getUint32(4, true)).toBe(100)
    expect(calls.some((call) => call.includes('/finish'))).toBe(false)
    socket.emit(JSON.stringify({
      type: 'transcript.final',
      segmentId: 'partial:0',
      id: 'seg_1',
      text: '你好',
      beginTime: 0,
      endTime: 800,
      speakerId: null,
      isFinal: true,
      sequence: 1,
    }))
    socket.emit(JSON.stringify({ type: 'session.completed', recordingId: 'rec_1', task: taskBody('QUEUED') }))
    await stopping
    expect(session.view.phase).toBe('processing')
    expect(session.view.segments.map((segment) => [segment.id, segment.content])).toEqual([['seg_1', '你好']])
    expect(session.view.audioSaved).toBe(true)
    expect(calls.some((call) => call.includes('/finish'))).toBe(false)
    session.dispose()
  })

  it('continues finishing when the socket closes without session.completed', async () => {
    const source = new FakePcm()
    const socket = new FakeSocket()
    const calls: string[] = []
    const session = createSession({
      media: media({
        pcmAvailable: true,
        createPcmSource: async () => source,
        createSocket: () => socket,
      }),
      request: async (path, init) => {
        calls.push(`${init?.method ?? 'GET'} ${path}`)
        if (path === '/api/recordings' && init?.method === 'POST') {
          return json(201, { data: { recording: { ...recordingBody, status: 'CREATED' }, knowledgeItemId: 'item_1' } })
        }
        if (path.endsWith('/start')) return json(200, { data: { recording: recordingBody } })
        if (path.endsWith('/finish')) throw new ApiError('录音当前状态不允许结束', 409, 'INVALID_RECORDING_STATE')
        if (path === '/api/recordings/rec_1') {
          return json(200, {
            data: {
              recording: { ...recordingBody, status: 'ENDED' },
              knowledgeItemId: 'item_1',
              chunks: [],
              segments: [],
              knowledgePoints: [],
              task: taskBody('QUEUED'),
            },
          })
        }
        if (path.startsWith('/api/tasks/')) return json(200, { data: { task: taskBody('QUEUED') } })
        throw new ApiError('请求失败', 500)
      },
    })
    await beginPcm(session, socket)
    source.push(new Uint8Array(9600))
    await vi.waitFor(() => expect(socket.frames()).toHaveLength(1))
    const stopping = session.stop()
    await vi.waitFor(() => expect(socket.texts().some((item) => item.includes('session.finish'))).toBe(true))
    socket.close()
    await stopping
    expect(session.view.phase).toBe('processing')
    expect(session.view.task?.id).toBe('task_rec')
    expect(calls.some((call) => call === 'GET /api/recordings/rec_1')).toBe(true)
    session.dispose()
  }, 4000)

  it('pauses the pcm session and resumes on a new asr status before capturing again', async () => {
    const source = new FakePcm()
    const socket = new FakeSocket()
    const session = createSession({
      media: media({
        pcmAvailable: true,
        createPcmSource: async () => source,
        createSocket: () => socket,
      }),
      request: recordingRequest(),
    })
    await beginPcm(session, socket)
    source.push(new Uint8Array([1, 2, 3, 4]))
    await vi.waitFor(() => expect(socket.frames()).toHaveLength(1))
    socket.emit(JSON.stringify({ type: 'transcript.partial', segmentId: 'partial:0', text: '临时', beginTime: 0, endTime: 100, speakerId: null, isFinal: false, sequence: 0 }))
    const pausing = session.pause()
    await vi.waitFor(() => expect(socket.texts().some((item) => item.includes('session.pause'))).toBe(true))
    await pausing
    socket.emit(JSON.stringify({ type: 'asr.status', status: 'paused' }))
    expect(session.view.paused).toBe(true)
    expect(session.view.segments).toEqual([])
    const framesAtPause = socket.frames().length
    source.push(new Uint8Array([5, 6, 7, 8]))
    expect(socket.frames()).toHaveLength(framesAtPause)

    const resuming = session.pause()
    await vi.waitFor(() => expect(socket.texts().some((item) => item.includes('session.resume'))).toBe(true))
    socket.emit(JSON.stringify({ type: 'asr.status', status: 'ready' }))
    await resuming
    expect(session.view.paused).toBe(false)
    source.push(new Uint8Array([5, 6, 7, 8]))
    await vi.waitFor(() => expect(socket.frames().length).toBe(framesAtPause + 1))
    const sequences = socket.frames().map((frame) => new DataView(frame).getUint32(0, true))
    expect(sequences).toEqual([0, 1, 2])
    session.dispose()
  })

  it('saves pcm through the chunk api when the socket cannot open and does not invent a transcript', async () => {
    const source = new FakePcm()
    const uploads: Array<{ type: string; sampleRate: string | null }> = []
    const session = createSession({
      media: media({
        pcmAvailable: true,
        createPcmSource: async () => source,
        createSocket: () => new FakeSocket(false),
      }),
      request: async (path, init) => {
        if (path === '/api/recordings' && init?.method === 'POST') {
          return json(201, { data: { recording: { ...recordingBody, status: 'CREATED' }, knowledgeItemId: 'item_1' } })
        }
        if (path.endsWith('/start')) return json(200, { data: { recording: recordingBody } })
        if (path.endsWith('/chunks')) {
          const form = init?.body as FormData
          const file = form.get('audio') as File
          uploads.push({ type: file.type, sampleRate: String(form.get('sampleRate')) })
          return json(201, chunkResponse(Number(form.get('sequence')), 'SKIPPED'))
        }
        if (path.endsWith('/finish')) return json(200, { data: { recording: { ...recordingBody, status: 'ENDED' }, task: taskBody('QUEUED') } })
        if (path.startsWith('/api/tasks/')) return json(200, { data: { task: taskBody('QUEUED') } })
        throw new ApiError('请求失败', 500)
      },
    })
    await session.start()
    expect(session.view.browserSampleRate).toBe(48000)
    source.push(new Uint8Array([1, 2, 3, 4]))
    await session.stop()
    expect(uploads.map((item) => item.type)).toEqual(['audio/pcm', 'audio/pcm'])
    expect(uploads.every((item) => item.sampleRate === '48000')).toBe(true)
    expect(session.view.phase).toBe('processing')
    expect(session.view.segments).toEqual([])
    session.dispose()
  })

  it('shows asr unavailable without creating transcript text', async () => {
    const source = new FakePcm()
    const socket = new FakeSocket()
    const session = createSession({
      media: media({
        pcmAvailable: true,
        createPcmSource: async () => source,
        createSocket: () => socket,
      }),
      request: recordingRequest(),
    })
    const pending = session.start()
    await vi.waitFor(() => expect(socket.texts().some((item) => item.includes('session.start'))).toBe(true))
    socket.emit(JSON.stringify({ type: 'session.ready', recordingId: 'rec_1', format: 'pcm', sampleRate: 48000, channels: 1, encoding: 'pcm_s16le' }))
    socket.emit(JSON.stringify({ type: 'asr.status', status: 'unavailable' }))
    await pending
    expect(session.view.liveTranscriptUnavailable).toBe(true)
    expect(session.view.message).toBe(LIVE_TRANSCRIPT_UNAVAILABLE_MESSAGE)
    expect(session.view.segments).toEqual([])
    expect(JSON.stringify(session.view)).not.toContain('你好')
    session.dispose()
  })
})

function taskBody(status: 'QUEUED' | 'FAILED', errorCode: string | null = null) {
  return {
    id: 'task_rec',
    fileId: null,
    taskType: 'PROCESS_RECORDING',
    status,
    currentStep: status === 'FAILED' ? 'TRANSCRIBE_AUDIO' : 'PERSIST_AUDIO',
    progress: status === 'FAILED' ? 35 : 0,
    errorCode,
    errorMessage: errorCode === 'ASR_UNAVAILABLE' ? '语音识别服务未配置' : null,
    startedAt: null,
    finishedAt: null,
  }
}

function chunkResponse(sequence: number, asrStatus: 'SKIPPED' | 'SUCCEEDED') {
  return {
    data: {
      chunk: {
        id: `chunk_${sequence}`,
        recordingId: 'rec_1',
        sequence,
        byteSize: 4,
        sha256: 'abc',
        mimeType: 'audio/webm;codecs=opus',
        asrStatus,
        createdAt: recordingBody.createdAt,
      },
      segments: [],
    },
  }
}

function media(overrides: Partial<RecordingMedia> = {}): RecordingMedia {
  return {
    pcmAvailable: false,
    createPcmSource: async () => {
      throw new Error('pcm')
    },
    createSocket: () => {
      throw new Error('socket')
    },
    recorderAvailable: true,
    getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }),
    isTypeSupported: (mime) => mime === 'audio/webm;codecs=opus',
    createRecorder: () => new FakeRecorder(),
    ...overrides,
  }
}

class FakeSocket implements RecordingSocket {
  sent: Array<string | ArrayBuffer> = []
  private message: (data: string) => void = () => undefined
  private closed: () => void = () => undefined
  private readonly opens: boolean

  constructor(opens = true) {
    this.opens = opens
  }

  isOpen(): boolean {
    return this.opens
  }

  bufferedAmount(): number {
    return 0
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed()
  }

  onMessage(listener: (data: string) => void): void {
    this.message = listener
  }

  onClose(listener: () => void): void {
    this.closed = listener
  }

  opened(): Promise<void> {
    return this.opens ? Promise.resolve() : Promise.reject(new Error('down'))
  }

  emit(data: string): void {
    this.message(data)
  }

  texts(): string[] {
    return this.sent.filter((item): item is string => typeof item === 'string')
  }

  frames(): ArrayBuffer[] {
    return this.sent.filter((item): item is ArrayBuffer => item instanceof ArrayBuffer)
  }
}

class FakePcm {
  sampleRate = 48000
  private onFrame: ((pcm: Uint8Array) => void) | null = null
  private accepting = false

  start(onFrame: (pcm: Uint8Array) => void): void {
    this.onFrame = onFrame
    this.accepting = true
  }

  push(pcm: Uint8Array): void {
    if (this.accepting) this.onFrame?.(pcm)
  }

  pause(): Uint8Array {
    this.accepting = false
    return new Uint8Array([9, 8])
  }

  resume(): void {
    this.accepting = true
  }

  stop(): Promise<Uint8Array> {
    this.accepting = false
    return Promise.resolve(new Uint8Array([1, 2, 3, 4]))
  }
}

function recordingRequest(): HttpRequest {
  return async (path, init) => {
    if (path === '/api/recordings' && init?.method === 'POST') {
      return json(201, { data: { recording: { ...recordingBody, status: 'CREATED' }, knowledgeItemId: 'item_1' } })
    }
    if (path.endsWith('/start')) return json(200, { data: { recording: recordingBody } })
    if (path.endsWith('/pause') || path.endsWith('/resume')) return json(200, { data: { recording: recordingBody } })
    throw new ApiError('请求失败', 500)
  }
}

async function beginPcm(session: RecordingSession, socket: FakeSocket): Promise<void> {
  const pending = session.start()
  await vi.waitFor(() => expect(socket.texts().some((item) => item.includes('session.start'))).toBe(true))
  socket.emit(JSON.stringify({ type: 'session.ready', recordingId: 'rec_1', format: 'pcm', sampleRate: 48000, channels: 1, encoding: 'pcm_s16le' }))
  await pending
}

function createSession(options: { media?: RecordingMedia; request?: HttpRequest }) {
  let latest: RecordingView | null = null
  const session = new RecordingSession({
    request: options.request ?? (async () => json(500, null)),
    media: options.media ?? media(),
    clock: clock(),
    onChange: (view) => { latest = view },
  })
  void latest
  return session
}
