/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RecordingResult } from './RecordingResult.tsx'
import { RecordingSheet } from './RecordingSheet.tsx'
import { TranscriptViewer } from './TranscriptViewer.tsx'
import type { RecordingMedia } from '../recording/session.ts'

afterEach(() => {
  cleanup()
})

describe('recording sheet', () => {
  it('shows saved audio without inventing a transcript when ASR returns nothing', () => {
    render(<TranscriptViewer segments={[]} unavailable audioSaved />)
    expect(screen.getByText('音频已保存')).toBeTruthy()
    expect(screen.getByText('实时转写暂不可用')).toBeTruthy()
    expect(screen.queryByText(/专家权/)).toBeNull()
  })

  it('shows a real segment and speaker only when the payload includes them', () => {
    render(<TranscriptViewer segments={[{
      id: 'seg_1',
      recordingId: 'rec_1',
      segmentIndex: 0,
      audioSequence: 0,
      content: '真实转写',
      startTimeMs: 0,
      endTimeMs: 1200,
      speakerId: 'spk_1',
      createdAt: '2026-11-04T00:00:00.000Z',
    }]} unavailable={false} audioSaved />)
    expect(screen.getByText('真实转写')).toBeTruthy()
    expect(screen.getByText('spk_1')).toBeTruthy()
  })

  it('shows an existing summary and does not present a failed recording as complete', () => {
    const recording = {
      id: 'rec_1',
      title: '录音',
      status: 'ENDED' as const,
      mimeType: 'audio/pcm',
      sampleRate: 48000,
      startedAt: '2026-11-08T03:00:00.000Z',
      endedAt: '2026-11-08T03:01:00.000Z',
      interruptedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: '2026-11-08T03:00:00.000Z',
      updatedAt: '2026-11-08T03:01:00.000Z',
    }
    const point = {
      id: 'kp_1',
      knowledgeItemId: 'item_1',
      recordingId: 'rec_1',
      sourceSegmentId: null,
      content: '已有知识点',
      startTimeMs: null,
      endTimeMs: null,
      speakerId: null,
      createdAt: recording.createdAt,
    }
    const { unmount } = render(<RecordingResult recording={recording} knowledgePoints={[point]} failed={false} summary={'已有摘要'} />)
    expect(screen.getByText('已有摘要')).toBeTruthy()
    expect(screen.getByText('已有知识点')).toBeTruthy()
    unmount()
    render(<RecordingResult recording={recording} knowledgePoints={[point]} failed summary={'已有摘要'} notice="转写失败" />)
    expect(screen.getByText('转写失败')).toBeTruthy()
    expect(screen.queryByText('已有摘要')).toBeNull()
    expect(screen.queryByText('已有知识点')).toBeNull()
    expect(screen.queryByText(/已提炼/)).toBeNull()
  })

  it('stops the microphone when the sheet unmounts', async () => {
    const stop = vi.fn()
    const media: RecordingMedia = {
      pcmAvailable: false,
      createPcmSource: async () => {
        throw new Error('pcm')
      },
      createSocket: () => {
        throw new Error('socket')
      },
      recorderAvailable: true,
      getUserMedia: async () => ({ getTracks: () => [{ stop }] }),
      isTypeSupported: (mime) => mime === 'audio/webm;codecs=opus',
      createRecorder: () => ({
        start: vi.fn(),
        stop: vi.fn(),
        addEventListener: vi.fn(),
      }),
    }
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/recordings' && init?.method === 'POST') {
        return { status: 201, body: { data: { recording: recording('CREATED'), knowledgeItemId: 'item_1' } } }
      }
      if (path.endsWith('/start')) return { status: 200, body: { data: { recording: recording('RECORDING') } } }
      return { status: 500, body: null }
    })
    const view = render(<RecordingSheet onClose={() => undefined} onUpdate={() => undefined} sessionOptions={{ media, request }} />)
    expect(await screen.findByText('正在录音')).toBeTruthy()
    view.unmount()
    expect(stop).toHaveBeenCalled()
  })
})

function recording(status: 'CREATED' | 'RECORDING') {
  return {
    id: 'rec_1',
    title: '录音',
    status,
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
}
