export type AsrAudioFormat = 'pcm' | 'wav' | 'mp3' | 'opus' | 'speex' | 'aac' | 'amr'

export const PREFERRED_RECORDING_MIMES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
] as const

export function audioFormatFromMime(mimeType: string): AsrAudioFormat {
  const mime = mimeType.toLowerCase()
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3'
  if (mime.includes('opus')) return 'opus'
  if (mime.includes('aac')) return 'aac'
  if (mime.includes('amr')) return 'amr'
  if (mime.includes('speex')) return 'speex'
  return 'pcm'
}

export function isUploadableRecordingMime(mimeType: string): boolean {
  const format = audioFormatFromMime(mimeType)
  if (format !== 'pcm') return true
  const mime = mimeType.toLowerCase()
  return mime.includes('pcm') || mime.includes('wav')
}

export function selectRecordingMime(isTypeSupported: (mime: string) => boolean): string | null {
  for (const mime of PREFERRED_RECORDING_MIMES) {
    if (isTypeSupported(mime) && isUploadableRecordingMime(mime)) return mime
  }
  return null
}
