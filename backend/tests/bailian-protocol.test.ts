import { describe, expect, it } from 'vitest'
import { inspectAudio, resamplePcm16le } from '../app/services/asr/audio-format.js'
import { createAsrProvider } from '../app/services/asr/create-asr-provider.js'
import { buildFinishTaskMessage, buildRunTaskMessage, readFinalTranscripts, readServerError, readTranscriptUpdate } from '../app/services/asr/bailian-protocol.js'
import { UnconfiguredAsrProvider } from '../app/services/asr/bailian-asr-provider.js'

describe('bailian realtime protocol', () => {
  it('resamples 16-bit PCM instead of only rewriting the sample rate', () => {
    const input = Buffer.alloc(8)
    input.writeInt16LE(0, 0)
    input.writeInt16LE(1000, 2)
    input.writeInt16LE(0, 4)
    input.writeInt16LE(-1000, 6)
    const output = resamplePcm16le(input, 8000, 16000)
    expect(output.length).toBe(16)
    expect(output).not.toEqual(input)
    expect(resamplePcm16le(input, 16000, 16000)).toBe(input)
  })

  it('builds the documented run-task and finish-task messages', () => {
    const run = JSON.parse(buildRunTaskMessage({
      taskId: 'task-1',
      model: 'paraformer-realtime-v2',
      format: 'pcm',
      sampleRate: 16000,
    })) as { header: { action: string; streaming: string }; payload: { parameters: Record<string, unknown> } }
    expect(run.header).toMatchObject({ action: 'run-task', task_id: 'task-1', streaming: 'duplex' })
    expect(run.payload.parameters).toMatchObject({ format: 'pcm', sample_rate: 16000 })
    expect(run.payload.parameters).not.toHaveProperty('diarization_enabled')

    const finish = JSON.parse(buildFinishTaskMessage('task-1')) as { header: { action: string; task_id: string } }
    expect(finish.header).toEqual({ action: 'finish-task', task_id: 'task-1', streaming: 'duplex' })
  })

  it('keeps final sentence text and timestamps, and speaker only when the payload has it', () => {
    expect(readFinalTranscripts({
      header: { event: 'result-generated' },
      payload: { output: { sentence: { sentence_end: true, text: '你好', begin_time: 10, end_time: 900 } } },
    })).toEqual([{ text: '你好', startTimeMs: 10, endTimeMs: 900, speakerId: null }])

    expect(readFinalTranscripts({
      header: { event: 'result-generated' },
      payload: { output: { sentence: { sentence_end: true, text: 'hello', begin_time: 0, end_time: 400, speaker_id: 'spk-2' } } },
    })[0]?.speakerId).toBe('spk-2')

    expect(readFinalTranscripts({
      header: { event: 'result-generated' },
      payload: { output: { sentence: { sentence_end: false, text: '未结束', begin_time: 0, end_time: 100 } } },
    })).toEqual([])
    expect(readFinalTranscripts({
      header: { event: 'result-generated' },
      payload: { output: { sentence: { heartbeat: true, sentence_end: true, text: '心跳', begin_time: 0, end_time: 1 } } },
    })).toEqual([])
    expect(readServerError({ header: { event: 'task-failed', error_message: '识别失败' } })).toBe('识别失败')
    expect(readTranscriptUpdate({
      header: { event: 'result-generated' },
      payload: { output: { sentence: { sentence_end: false, text: '你', begin_time: 0, end_time: 200 } } },
    })?.kind).toBe('partial')

    expect(readTranscriptUpdate({
      header: { event: 'result-generated' },
      payload: {
        output: {
          sentence: {
            sentence_end: true,
            text: '好，我知道了',
            begin_time: 170,
            end_time: null,
            words: [{ begin_time: 170, end_time: 920, text: '了' }],
          },
        },
      },
    })).toMatchObject({ kind: 'final', segment: { text: '好，我知道了', startTimeMs: 170, endTimeMs: 920 } })

    expect(readTranscriptUpdate({
      header: { event: 'result-generated' },
      payload: { output: { sentence: { sentence_end: false, text: '你好', begin_time: '120', end_time: null } } },
    })).toMatchObject({ kind: 'partial', segment: { text: '你好', startTimeMs: 120, endTimeMs: 120 } })
  })

  it('rejects WebM instead of declaring it as PCM or Ogg Opus', () => {
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00])
    expect(inspectAudio(webm, 'audio/webm')).toMatchObject({ compatible: false, container: 'webm' })
    expect(inspectAudio(webm, 'audio/webm;codecs=opus')).toMatchObject({ compatible: false, container: 'webm' })
    const fakeOpus = Buffer.from('not-ogg-opus!!')
    expect(inspectAudio(fakeOpus, 'audio/ogg;codecs=opus').compatible).toBe(false)
    const pcm = Buffer.alloc(4)
    expect(inspectAudio(pcm, 'audio/pcm')).toMatchObject({ compatible: true, format: 'pcm', sampleRate: null, channels: 1 })
  })

  it('does not open a socket when the ASR key is empty', async () => {
    const provider = createAsrProvider({ asrApiKey: '   ', asrModel: 'paraformer-realtime-v2', asrWsUrl: 'wss://example.invalid/inference' })
    expect(provider).toBeInstanceOf(UnconfiguredAsrProvider)
    expect(provider.isConfigured()).toBe(false)
    await expect(provider.openSession({ format: 'pcm', sampleRate: 16000 })).rejects.toMatchObject({ code: 'ASR_UNAVAILABLE' })
  })
})
