import { ApiError, REQUEST_FAILED_MESSAGE } from '../api/http.ts'
import type { TaskSnapshot } from './task.ts'
import { isTerminalTaskStatus } from './task-view.ts'

export const POLL_INTERVAL_MS = 1000
export const MAX_CONSECUTIVE_POLL_FAILURES = 5

export type TimerId = ReturnType<typeof setTimeout>

export type TaskClock = {
  setTimer: (callback: () => void, delayMs: number) => TimerId
  clearTimer: (id: TimerId) => void
}

export type PollOptions = TaskClock & {
  getTask: (taskId: string) => Promise<TaskSnapshot>
  isCurrent: () => boolean
  onTask: (task: TaskSnapshot) => void
  onGiveUp: (message: string) => void
  intervalMs?: number
  maxFailures?: number
}

const activePolls = new Map<string, () => void>()

export function stopAllTaskPolling() {
  for (const stop of [...activePolls.values()]) stop()
}

export function beginTaskPolling(taskId: string, options: PollOptions): { stop: () => void } {
  activePolls.get(taskId)?.()

  let timer: TimerId | null = null
  let stopped = false
  let failures = 0
  let epoch = 0
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS
  const maxFailures = options.maxFailures ?? MAX_CONSECUTIVE_POLL_FAILURES

  const stop = () => {
    if (stopped) return
    stopped = true
    epoch += 1
    if (timer != null) {
      options.clearTimer(timer)
      timer = null
    }
    if (activePolls.get(taskId) === stop) activePolls.delete(taskId)
  }

  const schedule = (token: number) => {
    timer = options.setTimer(() => {
      timer = null
      pump(token)
    }, intervalMs)
  }

  const pump = (token: number) => {
    if (stopped || token !== epoch || !options.isCurrent()) return
    void options.getTask(taskId).then(
      (task) => {
        if (stopped || token !== epoch || !options.isCurrent()) return
        if (task.id !== taskId) {
          schedule(token)
          return
        }
        failures = 0
        options.onTask(task)
        if (isTerminalTaskStatus(task.status)) {
          stop()
          return
        }
        schedule(token)
      },
      (error: unknown) => {
        if (stopped || token !== epoch || !options.isCurrent()) return
        failures += 1
        if (failures >= maxFailures) {
          options.onGiveUp(error instanceof ApiError ? error.message : REQUEST_FAILED_MESSAGE)
          stop()
          return
        }
        schedule(token)
      },
    )
  }

  activePolls.set(taskId, stop)
  pump(epoch)
  return { stop }
}
