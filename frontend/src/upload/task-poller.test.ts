import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/http.ts'
import type { TaskSnapshot } from './task.ts'
import { beginTaskPolling, stopAllTaskPolling } from './task-poller.ts'

function task(status: TaskSnapshot['status'], id = 'task_1'): TaskSnapshot {
  return {
    id,
    fileId: 'file_1',
    taskType: 'PROCESS_PDF',
    status,
    currentStep: 'EXTRACT_TEXT',
    progress: status === 'SUCCEEDED' ? 100 : 0,
    errorCode: status === 'FAILED' ? 'TASK_EXECUTION_FAILED' : null,
    errorMessage: status === 'FAILED' ? 'PDF 解析尚未接入' : null,
    startedAt: null,
    finishedAt: null,
  }
}

function clock() {
  return {
    setTimer: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimer: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  }
}

afterEach(() => {
  stopAllTaskPolling()
  vi.useRealTimers()
})

describe('beginTaskPolling', () => {
  it('stops after a terminal status and ignores a later timer', async () => {
    vi.useFakeTimers()
    const statuses: TaskSnapshot['status'][] = ['QUEUED', 'RUNNING', 'FAILED']
    let index = 0
    const getTask = vi.fn(async () => task(statuses[Math.min(index++, statuses.length - 1)] ?? 'FAILED'))
    const seen: string[] = []
    beginTaskPolling('task_1', {
      ...clock(),
      getTask,
      isCurrent: () => true,
      onTask: (next) => seen.push(next.status),
      onGiveUp: () => seen.push('give-up'),
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual(['QUEUED'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toEqual(['QUEUED', 'RUNNING'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toEqual(['QUEUED', 'RUNNING', 'FAILED'])
    await vi.advanceTimersByTimeAsync(5000)
    expect(getTask).toHaveBeenCalledTimes(3)
    expect(seen).not.toContain('give-up')
  })

  it('stops after five consecutive failures and keeps polling before that', async () => {
    vi.useFakeTimers()
    const getTask = vi.fn(async () => Promise.reject(new ApiError('请求失败', 0)))
    const giveUps: string[] = []
    beginTaskPolling('task_1', {
      ...clock(),
      getTask,
      isCurrent: () => true,
      onTask: () => undefined,
      onGiveUp: (message) => giveUps.push(message),
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(getTask).toHaveBeenCalledTimes(1)
    expect(giveUps).toEqual([])
    await vi.advanceTimersByTimeAsync(3000)
    expect(getTask).toHaveBeenCalledTimes(4)
    expect(giveUps).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(getTask).toHaveBeenCalledTimes(5)
    expect(giveUps).toEqual(['请求失败'])
    await vi.advanceTimersByTimeAsync(5000)
    expect(getTask).toHaveBeenCalledTimes(5)
  })

  it('drops a late response when the task is no longer current and keeps a single loop per task id', async () => {
    const resolvers: Array<(value: TaskSnapshot) => void> = []
    const getTask = vi.fn(() => new Promise<TaskSnapshot>((resolve) => {
      resolvers.push(resolve)
    }))
    const firstSeen: string[] = []
    const secondSeen: string[] = []
    let current = true
    beginTaskPolling('task_1', {
      ...clock(),
      getTask,
      isCurrent: () => current,
      onTask: (next) => firstSeen.push(next.id),
      onGiveUp: () => firstSeen.push('give-up'),
    })
    beginTaskPolling('task_1', {
      ...clock(),
      getTask,
      isCurrent: () => true,
      onTask: (next) => secondSeen.push(next.status),
      onGiveUp: () => secondSeen.push('give-up'),
    })

    current = false
    resolvers[0]?.(task('SUCCEEDED', 'task_1'))
    resolvers[1]?.(task('RUNNING', 'task_1'))
    await Promise.resolve()
    await Promise.resolve()

    expect(firstSeen).toEqual([])
    expect(secondSeen).toEqual(['RUNNING'])
    expect(getTask).toHaveBeenCalledTimes(2)
  })
})
