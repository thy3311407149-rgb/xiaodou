import { describe, expect, it } from 'vitest'
import { applyTranscriptEvent, confirmedSegments, encodePcmFrame, floatToPcm16, frameSampleCount, parseServerEvent, pcmToWav, recordingStreamUrl, SampleBuffer } from './realtime.ts'

describe('realtime pcm protocol', () => {
  it('builds a backend stream url and never points at the asr vendor', () => {
    const url = recordingStreamUrl('rec a', { protocol: 'http:', host: '127.0.0.1:5173' })
    expect(url).toBe('ws://127.0.0.1:5173/api/recordings/rec%20a/stream')
    expect(url).not.toContain('aliyun')
    expect(url).not.toContain('dashscope')
  })

  it('encodes little-endian pcm and converts the actual samples', () => {
    expect(frameSampleCount(48000)).toBe(4800)
    const frame = encodePcmFrame(2, 100, Uint8Array.from([1, 2, 3, 4]))
    const view = new DataView(frame)
    expect(view.getUint32(0, true)).toBe(2)
    expect(view.getUint32(4, true)).toBe(100)
    expect(new Uint8Array(frame).subarray(8)).toEqual(Uint8Array.from([1, 2, 3, 4]))
    const pcm = floatToPcm16(Float32Array.from([1, -1, 0]))
    const samples = new Int16Array(pcm.buffer)
    expect(samples[0]).toBe(32767)
    expect(samples[1]).toBe(-32768)
    expect(samples[2]).toBe(0)
  })

  it('emits 100ms frames and keeps the tail for the final flush', () => {
    const buffer = new SampleBuffer(2)
    expect(buffer.push(Uint8Array.from([1, 2]))).toEqual([])
    expect(buffer.push(Uint8Array.from([3, 4, 5, 6]))).toEqual([Uint8Array.from([1, 2, 3, 4])])
    expect(buffer.flush()).toEqual(Uint8Array.from([5, 6]))
  })

  it('replaces a partial with the same segment id and turns the final into one saved row', () => {
    const first = applyTranscriptEvent('rec_1', [], {
      type: 'transcript.partial',
      segmentId: 'partial:0',
      text: '你',
      beginTime: 0,
      endTime: 120,
      speakerId: null,
      isFinal: false,
      sequence: 1,
    })
    const replaced = applyTranscriptEvent('rec_1', first, {
      type: 'transcript.partial',
      segmentId: 'partial:0',
      text: '你好',
      beginTime: 0,
      endTime: 240,
      speakerId: null,
      isFinal: false,
      sequence: 2,
    })
    expect(replaced).toHaveLength(1)
    expect(replaced[0]?.content).toBe('你好')
    expect(replaced[0]?.id).toBe('partial:0')
    const final = applyTranscriptEvent('rec_1', replaced, {
      type: 'transcript.final',
      segmentId: 'partial:0',
      id: 'seg_1',
      text: '你好',
      beginTime: 0,
      endTime: 400,
      speakerId: null,
      isFinal: true,
      sequence: 3,
    })
    expect(final.map((item) => [item.id, item.content])).toEqual([['seg_1', '你好']])
    const next = applyTranscriptEvent('rec_1', final, {
      type: 'transcript.partial',
      segmentId: 'partial:400',
      text: '下一段',
      beginTime: 400,
      endTime: 500,
      speakerId: null,
      isFinal: false,
      sequence: 4,
    })
    expect(next.map((item) => item.content)).toEqual(['你好', '下一段'])
    expect(confirmedSegments(next).map((item) => item.content)).toEqual(['你好'])
  })

  it('parses server events and wraps saved pcm as wav using the declared rate', () => {
    expect(parseServerEvent('{"type":"asr.status","status":"paused"}')).toEqual({ type: 'asr.status', status: 'paused' })
    expect(parseServerEvent('not-json')).toBeNull()
    const wav = pcmToWav(Uint8Array.from([1, 2, 3, 4]), 48000)
    expect(wav.type).toBe('audio/wav')
    expect(wav.size).toBe(48)
  })
})
