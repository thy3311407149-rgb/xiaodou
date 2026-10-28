import { Router } from 'express'
import { ApplicationError } from '../core/errors/application-error.js'
import { TaskRepository } from '../repositories/task-repository.js'
import { toPublicTask } from './task-response.js'

type TaskRouterOptions = {
  taskRepository?: TaskRepository
}

export function createTaskRouter(options: TaskRouterOptions = {}): Router {
  const router = Router()
  let repository = options.taskRepository
  const getRepository = (): TaskRepository => {
    repository ??= new TaskRepository()
    return repository
  }

  router.get('/api/tasks/:taskId', (request, response, next) => {
    try {
      const taskId = request.params.taskId
      const task = getRepository().findById(taskId)
      if (!task) {
        throw new ApplicationError('TASK_NOT_FOUND', { taskId })
      }
      response.json({ requestId: request.requestId, data: { task: toPublicTask(task) } })
    } catch (error: unknown) {
      next(error)
    }
  })

  return router
}

export const taskRouter = createTaskRouter()
