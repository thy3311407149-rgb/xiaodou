import { ApiError, REQUEST_FAILED_MESSAGE } from '../api/http.ts'
import { validatePdfFile } from './pdf-file.ts'
import { beginTaskPolling, type TaskClock } from './task-poller.ts'
import type { TaskSnapshot, UploadedPdf } from './task.ts'

export type UploadListener = {
  onRejected: (message: string) => void
  onUploadFailed: (message: string) => void
  onAccepted: (upload: UploadedPdf) => void
  onTask: (task: TaskSnapshot) => void
  onPollFailed: (message: string, taskId: string) => void
}

export type UploadSessionDeps = TaskClock & {
  upload: (file: File) => Promise<UploadedPdf>
  getTask: (taskId: string) => Promise<TaskSnapshot>
  listener: UploadListener
}

export function createUploadSession(deps: UploadSessionDeps) {
  let generation = 0
  let activeStop: (() => void) | null = null

  const stopActive = () => {
    activeStop?.()
    activeStop = null
  }

  return {
    async submit(file: File) {
      const validation = validatePdfFile(file)
      if (!validation.ok) {
        deps.listener.onRejected(validation.message)
        return
      }

      const ticket = ++generation
      stopActive()

      try {
        const uploaded = await deps.upload(file)
        if (ticket !== generation) return
        deps.listener.onAccepted(uploaded)
        const poll = beginTaskPolling(uploaded.task.id, {
          getTask: deps.getTask,
          setTimer: deps.setTimer,
          clearTimer: deps.clearTimer,
          isCurrent: () => ticket === generation,
          onTask: (task) => {
            if (ticket !== generation) return
            deps.listener.onTask(task)
          },
          onGiveUp: (message) => {
            if (ticket !== generation) return
            deps.listener.onPollFailed(message, uploaded.task.id)
          },
        })
        if (ticket !== generation) {
          poll.stop()
          return
        }
        activeStop = poll.stop
      } catch (error: unknown) {
        if (ticket !== generation) return
        deps.listener.onUploadFailed(error instanceof ApiError ? error.message : REQUEST_FAILED_MESSAGE)
      }
    },
    dispose() {
      generation += 1
      stopActive()
    },
  }
}
