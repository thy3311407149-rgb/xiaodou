export const MAX_CHUNK_ATTEMPTS = 3

export type QueuedChunk<T> = {
  sequence: number
  saved: number
  result: T
}

export class ChunkQueue<T> {
  private assigned = 0
  private saved = 0
  private halted = false
  private blocked: { sequence: number; blob: Blob } | null = null
  private waiting: Array<{ sequence: number; blob: Blob }> = []
  private tail: Promise<void> = Promise.resolve()
  private lastError: unknown = null
  private readonly upload: (sequence: number, blob: Blob) => Promise<T>
  private readonly onSaved: (saved: QueuedChunk<T>) => void
  private readonly onFailed: (error: unknown) => void

  constructor(
    upload: (sequence: number, blob: Blob) => Promise<T>,
    onSaved: (saved: QueuedChunk<T>) => void,
    onFailed: (error: unknown) => void = () => undefined,
  ) {
    this.upload = upload
    this.onSaved = onSaved
    this.onFailed = onFailed
  }

  get savedCount(): number {
    return this.saved
  }

  get blockedSequence(): number | null {
    return this.blocked?.sequence ?? null
  }

  enqueue(blob: Blob): void {
    if (blob.size <= 0) return
    const sequence = this.assigned
    this.assigned += 1
    this.tail = this.tail.catch(() => undefined).then(() => this.offer(sequence, blob))
  }

  async flush(): Promise<void> {
    await this.tail
    if (this.halted) {
      const error = this.lastError
      throw error instanceof Error ? error : new Error('音频分片上传失败')
    }
  }

  retry(): void {
    if (!this.blocked) return
    const failed = this.blocked
    const rest = this.waiting.splice(0)
    this.blocked = null
    this.halted = false
    this.lastError = null
    this.tail = this.tail.catch(() => undefined).then(async () => {
      await this.send(failed.sequence, failed.blob)
      for (const next of rest) {
        if (this.halted) {
          this.waiting.push(next)
          return
        }
        await this.send(next.sequence, next.blob)
      }
    })
  }

  private async offer(sequence: number, blob: Blob): Promise<void> {
    if (this.halted) {
      this.waiting.push({ sequence, blob })
      return
    }
    await this.send(sequence, blob)
  }

  private async send(sequence: number, blob: Blob): Promise<void> {
    let attempts = 0
    while (attempts < MAX_CHUNK_ATTEMPTS) {
      try {
        const result = await this.upload(sequence, blob)
        this.saved = sequence + 1
        this.onSaved({ sequence, saved: this.saved, result })
        return
      } catch (error: unknown) {
        attempts += 1
        this.lastError = error
      }
    }
    this.halted = true
    this.blocked = { sequence, blob }
    const error = this.lastError instanceof Error ? this.lastError : new Error('音频分片上传失败')
    this.onFailed(error)
    throw error
  }
}
