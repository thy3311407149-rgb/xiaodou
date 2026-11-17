import { describe, expect, it, vi } from 'vitest'
import { ChunkQueue } from './chunk-queue.ts'

describe('chunk queue', () => {
  it('uploads from sequence 0 and waits for the previous chunk', async () => {
    const gate: { release: () => void } = { release: () => undefined }
    const calls: number[] = []
    const queue = new ChunkQueue(async (sequence: number) => {
      calls.push(sequence)
      if (sequence === 0) await new Promise<void>((resolve) => { gate.release = resolve })
      return sequence
    }, () => undefined)
    queue.enqueue(new Blob(['a']))
    queue.enqueue(new Blob(['b']))
    queue.enqueue(new Blob([]))
    await vi.waitFor(() => expect(calls).toEqual([0]))
    gate.release()
    await queue.flush()
    expect(calls).toEqual([0, 1])
    expect(queue.savedCount).toBe(2)
  })

  it('does not upload the next sequence after the current chunk fails', async () => {
    let fail = true
    const uploaded: number[] = []
    const queue = new ChunkQueue(async (sequence: number) => {
      if (sequence === 0 && fail) throw new Error('network')
      uploaded.push(sequence)
      return sequence
    }, () => undefined)
    queue.enqueue(new Blob(['a']))
    queue.enqueue(new Blob(['b']))
    await expect(queue.flush()).rejects.toThrow('network')
    expect(uploaded).toEqual([])
    expect(queue.blockedSequence).toBe(0)
    fail = false
    queue.retry()
    await queue.flush()
    expect(uploaded).toEqual([0, 1])
  })
})
