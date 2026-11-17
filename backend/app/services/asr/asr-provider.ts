export type AsrAudioFormat = 'pcm' | 'wav' | 'mp3' | 'opus' | 'speex' | 'aac' | 'amr'

export type AsrSessionOptions = {
  format: AsrAudioFormat
  sampleRate: number
}

export type AsrTranscriptSegment = {
  text: string
  startTimeMs: number
  endTimeMs: number
  speakerId: string | null
}

export type AsrStreamEvent =
  | { type: 'partial'; segment: AsrTranscriptSegment }
  | { type: 'final'; segment: AsrTranscriptSegment }

export interface AsrSession {
  readonly sessionId?: string
  pushAudio(audio: Buffer): Promise<AsrTranscriptSegment[]>
  finish(): Promise<AsrTranscriptSegment[]>
  setListener?(listener: ((event: AsrStreamEvent) => void) | null): void
}

export interface AsrProvider {
  readonly name: string
  isConfigured(): boolean
  openSession(options: AsrSessionOptions): Promise<AsrSession>
}

export function audioFormatFromMime(mimeType: string): AsrAudioFormat | null {
  const mime = mimeType.toLowerCase()
  if (mime.includes('webm') || mime.includes('matroska')) return null
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3'
  if (mime.includes('aac')) return 'aac'
  if (mime.includes('amr')) return 'amr'
  if (mime.includes('speex')) return 'speex'
  if (mime.includes('ogg') || mime.includes('opus')) return 'opus'
  if (mime.includes('pcm') || mime.includes('l16') || mime.includes('audio/raw')) return 'pcm'
  return null
}
