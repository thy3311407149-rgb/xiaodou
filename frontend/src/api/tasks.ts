import { ApiError, REQUEST_FAILED_MESSAGE, http, type HttpRequest } from './http.ts'
import { parseTaskResponse, type TaskSnapshot } from '../upload/task.ts'

export async function fetchTask(taskId: string, request: HttpRequest = http.request): Promise<TaskSnapshot> {
  const response = await request(`/api/tasks/${encodeURIComponent(taskId)}`)
  const task = parseTaskResponse(response.body)
  if (!task || task.id !== taskId) throw new ApiError(REQUEST_FAILED_MESSAGE, response.status)
  return task
}
