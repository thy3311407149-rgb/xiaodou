import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RecordingTask } from '../api/recordings.ts'
import { stopAllTaskPolling } from '../upload/task-poller.ts'
import { RECORDING_POLL_INTERVAL_MS, watchRecordingTask } from './poll.ts'

function task(status: RecordingTask['status']): RecordingTask {
  return {
    id: 'task_rec',
    fileId: null,
    taskType: 'PROCESS_RECORDING',
    status,
    currentStep: status === 'FAILED' ? 'TRANSCRIBE_AUDIO' : 'PERSIST_AUDIO',
    progress: status === 'FAILED' ? 35 : 15,
    errorCode: status === 'FAILED' ? 'ASR_UNAVAILABLE' : null,
    errorMessage: status === 'FAILED' ? '语音识别服务未配置' : null,
    startedAt: null,
    finishedAt: null,
  }
}

afterEach(() => {
  stopAllTaskPolling()
  vi.useRealTimers()
})

describe('recording task polling', () => {
  it('polls on the recording interval and stops when the task fails', async () => {
    vi.useFakeTimers()
    const statuses: RecordingTask['status'][] = ['QUEUED', 'RUNNING', 'FAILED']
    let index = 0
    const getTask = vi.fn(async () => task(statuses[Math.min(index++, statuses.length - 1)] ?? 'FAILED'))
    const seen: string[] = []
    watchRecordingTask('task_rec', {
      getTask,
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (id) => clearTimeout(id),
      isCurrent: () => true,
      onTask: (next) => seen.push(next.status),
      onGiveUp: () => undefined,
    })
    await vi.waitFor(() => expect(seen).toEqual(['QUEUED']))
    await vi.advanceTimersByTimeAsync(RECORDING_POLL_INTERVAL_MS)
    await vi.waitFor(() => expect(seen).toEqual(['QUEUED', 'RUNNING']))
    await vi.advanceTimersByTimeAsync(RECORDING_POLL_INTERVAL_MS)
    await vi.waitFor(() => expect(seen).toEqual(['QUEUED', 'RUNNING', 'FAILED']))
    await vi.advanceTimersByTimeAsync(RECORDING_POLL_INTERVAL_MS)
    expect(getTask).toHaveBeenCalledTimes(3)
  })

  it('stops polling when the task succeeds', async () => {
    vi.useFakeTimers()
    const getTask = vi.fn(async () => task('SUCCEEDED'))
    const seen: string[] = []
    watchRecordingTask('task_rec', {
      getTask,
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (id) => clearTimeout(id),
      isCurrent: () => true,
      onTask: (next) => seen.push(next.status),
      onGiveUp: () => undefined,
    })
    await vi.waitFor(() => expect(seen).toEqual(['SUCCEEDED']))
    await vi.advanceTimersByTimeAsync(RECORDING_POLL_INTERVAL_MS * 2)
    expect(getTask).toHaveBeenCalledTimes(1)
  })
})
