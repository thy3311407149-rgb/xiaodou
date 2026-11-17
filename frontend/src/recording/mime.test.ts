import { describe, expect, it } from 'vitest'
import { audioFormatFromMime, selectRecordingMime } from './mime.ts'

describe('recording mime', () => {
  it('selects the first supported opus mime and rejects a container the backend would treat as pcm', () => {
    expect(selectRecordingMime((mime) => mime === 'audio/ogg;codecs=opus')).toBe('audio/ogg;codecs=opus')
    expect(selectRecordingMime((mime) => mime === 'audio/webm')).toBeNull()
    expect(selectRecordingMime(() => false)).toBeNull()
  })

  it('maps mime the same way as the backend adapter', () => {
    expect(audioFormatFromMime('audio/webm;codecs=opus')).toBe('opus')
    expect(audioFormatFromMime('audio/ogg;codecs=opus')).toBe('opus')
    expect(audioFormatFromMime('audio/webm')).toBe('pcm')
    expect(audioFormatFromMime('audio/mp4')).toBe('pcm')
  })
})
