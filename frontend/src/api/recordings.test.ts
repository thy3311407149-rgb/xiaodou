import { describe, expect, it, vi } from 'vitest'
import { createHttp } from './http.ts'
import { createRecording, fetchRecording, fetchRecordingList, finishRecording, uploadRecordingChunk } from './recordings.ts'

const recording = {
  id: 'rec_1',
  title: '录音',
  status: 'RECORDING',
  mimeType: null,
  sampleRate: 16000,
  startedAt: '2026-11-04T00:00:00.000Z',
  endedAt: null,
  interruptedAt: null,
  errorCode: null,
  errorMessage: null,
  createdAt: '2026-11-04T00:00:00.000Z',
  updatedAt: '2026-11-04T00:00:00.000Z',
}

describe('recording client', () => {
  it('creates a recording with the title field and reads the recording id', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')
      expect(init?.body).toBe(JSON.stringify({ title: '录音' }))
      return new Response(JSON.stringify({
        requestId: 'req_1',
        data: { recording: { ...recording, status: 'CREATED' }, knowledgeItemId: 'item_1' },
      }), { status: 201 })
    })
    const client = createHttp(fetchImpl as typeof fetch)
    await expect(createRecording('录音', client.request)).resolves.toMatchObject({
      recording: { id: 'rec_1', status: 'CREATED' },
      knowledgeItemId: 'item_1',
    })
  })

  it('uploads audio and sequence in order without rewriting the blob type', async () => {
    const audio = new Blob([Uint8Array.from([1, 2, 3])], { type: 'audio/webm;codecs=opus' })
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/recordings/rec_1/chunks')
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('Content-Type')).toBeNull()
      const form = init?.body as FormData
      expect(form.get('sequence')).toBe('0')
      const file = form.get('audio') as File
      expect(file.type).toBe('audio/webm;codecs=opus')
      return new Response(JSON.stringify({
        requestId: 'req_chunk',
        data: {
          chunk: {
            id: 'chunk_1',
            recordingId: 'rec_1',
            sequence: 0,
            byteSize: 3,
            sha256: 'abc',
            mimeType: file.type,
            asrStatus: 'SKIPPED',
            createdAt: recording.createdAt,
          },
          segments: [],
        },
      }), { status: 201 })
    })
    const client = createHttp(fetchImpl as typeof fetch)
    await expect(uploadRecordingChunk('rec_1', 0, audio, client.request)).resolves.toMatchObject({
      chunk: { sequence: 0, asrStatus: 'SKIPPED', mimeType: 'audio/webm;codecs=opus' },
      segments: [],
    })
  })

  it('reads the process task id from finish', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      requestId: 'req_finish',
      data: {
        recording: { ...recording, status: 'ENDED', endedAt: '2026-11-04T00:01:00.000Z' },
        task: {
          id: 'task_rec',
          fileId: null,
          taskType: 'PROCESS_RECORDING',
          status: 'QUEUED',
          currentStep: 'PERSIST_AUDIO',
          progress: 0,
          errorCode: null,
          errorMessage: null,
          startedAt: null,
          finishedAt: null,
        },
      },
    }), { status: 200 }))
    const client = createHttp(fetchImpl as typeof fetch)
    await expect(finishRecording('rec_1', client.request)).resolves.toMatchObject({
      recording: { status: 'ENDED' },
      task: { id: 'task_rec', taskType: 'PROCESS_RECORDING', fileId: null },
    })
  })

  it('loads a recording page and keeps the existing summary on the detail request', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/recordings?')) {
        return new Response(JSON.stringify({
          requestId: 'req_list',
          data: {
            items: [{
              recordingId: 'rec_new',
              title: '新录音',
              createdAt: '2026-11-08T03:00:00.000Z',
              durationMs: null,
              status: 'CREATED',
              processingStatus: null,
              summaryGenerated: false,
            }, {
              recordingId: 'rec_failed',
              title: '失败录音',
              createdAt: '2026-11-08T02:00:00.000Z',
              durationMs: 500,
              status: 'ENDED',
              processingStatus: 'FAILED',
              summaryGenerated: false,
            }],
            page: 1,
            pageSize: 2,
            total: 3,
          },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        requestId: 'req_detail',
        data: {
          recording,
          knowledgeItemId: 'item_1',
          chunks: [],
          segments: [],
          knowledgePoints: [],
          summary: { id: 'summary_1', content: '已有摘要', recordingId: 'rec_1' },
          task: null,
        },
      }), { status: 200 })
    })
    const client = createHttp(fetchImpl as typeof fetch)
    const listed = await fetchRecordingList(1, 2, client.request)
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('/api/recordings?page=1&pageSize=2')
    expect(listed.total).toBe(3)
    expect(listed.items.map((item) => item.recordingId)).toEqual(['rec_new', 'rec_failed'])
    expect(listed.items[1]?.processingStatus).toBe('FAILED')
    const detail = await fetchRecording('rec_1', client.request)
    expect(detail.summary?.content).toBe('已有摘要')
    const calls = fetchImpl.mock.calls as Array<[RequestInfo | URL, RequestInit?]>
    expect(calls.map((call) => call[1]?.method ?? 'GET')).toEqual(['GET', 'GET'])
  })
})
