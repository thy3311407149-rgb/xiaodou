import { fetchRecordingTask, type RecordingTask } from '../api/recordings.ts'
import { beginTaskPolling, type PollOptions } from '../upload/task-poller.ts'

export const RECORDING_POLL_INTERVAL_MS = 1500

export function watchRecordingTask(
  taskId: string,
  options: Omit<PollOptions<RecordingTask>, 'getTask' | 'intervalMs'> & {
    getTask?: (taskId: string) => Promise<RecordingTask>
    intervalMs?: number
  },
): { stop: () => void } {
  return beginTaskPolling<RecordingTask>(taskId, {
    ...options,
    intervalMs: options.intervalMs ?? RECORDING_POLL_INTERVAL_MS,
    getTask: (id) => options.getTask?.(id) ?? fetchRecordingTask(id),
  })
}
