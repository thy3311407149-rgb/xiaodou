import { Router } from 'express'
import { config } from '../core/config.js'
import { ApplicationError } from '../core/errors/application-error.js'
import { TextChunkRepository } from '../repositories/text-chunk-repository.js'
import { KnowledgeAskService } from '../services/knowledge/knowledge-ask-service.js'
import { KnowledgeRetrievalService } from '../services/knowledge/knowledge-retrieval-service.js'
import { HttpLlmClient } from '../services/llm/llm-client.js'

type KnowledgeRouterOptions = {
  retrievalService?: KnowledgeRetrievalService
  askService?: KnowledgeAskService
}

export function createKnowledgeRouter(options: KnowledgeRouterOptions = {}): Router {
  const router = Router()
  let service = options.retrievalService
  let askService = options.askService
  const getService = (): KnowledgeRetrievalService => {
    service ??= new KnowledgeRetrievalService(new TextChunkRepository())
    return service
  }
  const getAskService = (): KnowledgeAskService => {
    askService ??= new KnowledgeAskService(getService(), new HttpLlmClient({
      baseUrl: config.llmBaseUrl,
      apiKey: config.llmApiKey,
      model: config.llmModel,
      timeoutMs: config.llmTimeoutMs,
      maxRetries: config.llmMaxRetries,
      maxTokens: config.llmMaxOutputTokens,
      temperature: config.llmTemperature,
    }))
    return askService
  }

  router.post('/api/knowledge/search', (request, response, next) => {
    try {
      const query = request.body?.query
      if (typeof query !== 'string' || query.trim().length === 0) {
        throw new ApplicationError('INVALID_REQUEST', { message: 'query 不能为空' })
      }
      const result = getService().search(query)
      response.json({ requestId: request.requestId, data: { chunks: result.chunks } })
    } catch (error: unknown) {
      next(error)
    }
  })

  router.post('/api/knowledge/ask', async (request, response, next) => {
    try {
      const query = request.body?.query
      if (typeof query !== 'string' || query.trim().length === 0) {
        throw new ApplicationError('INVALID_REQUEST', { message: 'query 不能为空' })
      }
      const result = await getAskService().ask(query)
      response.json({ requestId: request.requestId, data: result })
    } catch (error: unknown) {
      next(error)
    }
  })

  return router
}

export const knowledgeRouter = createKnowledgeRouter()
