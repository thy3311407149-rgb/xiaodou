import { ApplicationError } from '../../core/errors/application-error.js'
export type LlmMessage = {
  role: 'system' | 'user'
  content: string
}

export type LlmCompletion = {
  content: string
  modelName: string
  inputTokens: number
  outputTokens: number
}

export type LlmClient = {
  complete(messages: readonly LlmMessage[]): Promise<LlmCompletion>
}

export type LlmClientOptions = {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
  maxRetries: number
  maxTokens?: number
  temperature?: number
}

type ChatResponse = {
  model?: string
  choices?: Array<{ message?: { content?: string | null } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export class HttpLlmClient implements LlmClient {
  constructor(
    private readonly options: LlmClientOptions,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: (milliseconds: number) => Promise<void> = delay,
  ) {}

  async complete(messages: readonly LlmMessage[]): Promise<LlmCompletion> {
    if (this.options.apiKey.trim().length === 0) {
      throw new ApplicationError('SUMMARY_GENERATION_FAILED', { message: '未配置 LLM 服务' })
    }

    const attempts = Math.max(0, this.options.maxRetries) + 1
    let lastError: ApplicationError | null = null
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.requestOnce(messages)
      } catch (error: unknown) {
        lastError = toLlmError(error)
        if (attempt >= attempts - 1 || !isRetryable(lastError)) throw lastError
        await this.sleep(200 * (attempt + 1))
      }
    }
    throw lastError ?? new ApplicationError('SUMMARY_GENERATION_FAILED')
  }

  private async requestOnce(messages: readonly LlmMessage[]): Promise<LlmCompletion> {
    const url = `${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.model,
          temperature: this.options.temperature ?? 0.2,
          max_tokens: this.options.maxTokens ?? 1200,
          messages,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      })
    } catch (error: unknown) {
      if (isTimeout(error)) throw new ApplicationError('LLM_TIMEOUT')
      throw new ApplicationError('SUMMARY_GENERATION_FAILED', { details: { retryable: true } })
    }

    if (response.status === 429) throw new ApplicationError('LLM_RATE_LIMITED')
    if (response.status >= 500) throw new ApplicationError('SUMMARY_GENERATION_FAILED', { details: { retryable: true } })
    if (!response.ok) throw new ApplicationError('SUMMARY_GENERATION_FAILED')

    let body: ChatResponse
    try {
      body = await response.json() as ChatResponse
    } catch {
      throw new ApplicationError('LLM_INVALID_RESPONSE')
    }

    const content = body.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new ApplicationError('LLM_INVALID_RESPONSE')
    }

    return {
      content,
      modelName: typeof body.model === 'string' && body.model.length > 0 ? body.model : this.options.model,
      inputTokens: normalizeTokenCount(body.usage?.prompt_tokens),
      outputTokens: normalizeTokenCount(body.usage?.completion_tokens),
    }
  }
}

function isRetryable(error: ApplicationError): boolean {
  if (error.code === 'LLM_TIMEOUT' || error.code === 'LLM_RATE_LIMITED') return true
  return error.code === 'SUMMARY_GENERATION_FAILED'
    && typeof error.details === 'object'
    && error.details !== null
    && 'retryable' in error.details
    && error.details.retryable === true
}

function toLlmError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error
  if (isTimeout(error)) return new ApplicationError('LLM_TIMEOUT')
  return new ApplicationError('SUMMARY_GENERATION_FAILED', { cause: error })
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

function normalizeTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds)
  })
}
