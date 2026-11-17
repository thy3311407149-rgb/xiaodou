import type { AsrAudioFormat } from './asr-provider.js'

export type CompatibleAudio = {
  compatible: true
  format: AsrAudioFormat
  sampleRate: number | null
  channels: number
  container: 'pcm' | 'wav' | 'ogg' | 'amr'
}

export type IncompatibleAudio = {
  compatible: false
  container: string
  reason: string
}

const WEBM_REASON = 'WebM 不在百炼实时识别支持的封装中，不能声明为 PCM 或 Ogg Opus'

export function inspectAudio(bytes: Buffer, mimeType: string): CompatibleAudio | IncompatibleAudio {
  if (isWebM(bytes) || mimeType.toLowerCase().includes('webm') || mimeType.toLowerCase().includes('matroska')) {
    return { compatible: false, container: 'webm', reason: WEBM_REASON }
  }
  if (bytes.subarray(0, 4).toString('ascii') === 'OggS') return inspectOgg(bytes)
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE') return inspectWav(bytes)
  if (bytes.subarray(0, 5).toString('ascii') === '#!AMR') {
    return { compatible: true, format: 'amr', sampleRate: 8000, channels: 1, container: 'amr' }
  }
  const mime = mimeType.toLowerCase()
  if (mime.includes('opus') || mime.includes('ogg') || mime.includes('speex')) {
    return { compatible: false, container: 'unknown', reason: '仅修改 MIME 不能把非 Ogg 数据声明为 Ogg Opus' }
  }
  if (mime.includes('pcm') || mime.includes('l16') || mime.includes('audio/raw')) {
    if (bytes.length % 2 !== 0) {
      return { compatible: false, container: 'pcm', reason: 'PCM 必须是 16-bit 单声道小端，字节长度必须为偶数' }
    }
    return { compatible: true, format: 'pcm', sampleRate: null, channels: 1, container: 'pcm' }
  }
  return { compatible: false, container: 'unknown', reason: '音频格式与百炼实时识别不兼容' }
}

export function resamplePcm16le(input: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return input
  if (!Number.isInteger(fromRate) || !Number.isInteger(toRate) || fromRate <= 0 || toRate <= 0) {
    throw new Error('invalid sample rate')
  }
  if (input.length % 2 !== 0) throw new Error('pcm length must be even')
  const inputSamples = input.length / 2
  if (inputSamples === 0) return Buffer.alloc(0)
  const outputSamples = Math.max(1, Math.round(inputSamples * toRate / fromRate))
  const output = Buffer.alloc(outputSamples * 2)
  const last = inputSamples - 1
  for (let index = 0; index < outputSamples; index += 1) {
    const position = index * fromRate / toRate
    const left = Math.min(last, Math.floor(position))
    const right = Math.min(last, left + 1)
    const fraction = position - left
    const start = input.readInt16LE(left * 2)
    const end = input.readInt16LE(right * 2)
    const value = Math.round(start + (end - start) * fraction)
    output.writeInt16LE(Math.max(-32768, Math.min(32767, value)), index * 2)
  }
  return output
}

export function resolveSampleRate(detected: number | null, declared: number | null): { sampleRate: number } | { reason: string } {
  if (detected && declared && detected !== declared) {
    return { reason: '声明的采样率与音频内容不一致' }
  }
  const sampleRate = detected ?? declared
  if (!sampleRate || !Number.isInteger(sampleRate) || sampleRate <= 0) {
    return { reason: '缺少实际采样率' }
  }
  return { sampleRate }
}

function inspectOgg(bytes: Buffer): CompatibleAudio | IncompatibleAudio {
  const head = bytes.indexOf('OpusHead')
  if (head < 0 || head + 16 > bytes.length) {
    return { compatible: false, container: 'ogg', reason: 'Ogg 数据缺少 OpusHead，不能按 Opus 发送' }
  }
  const channels = bytes[head + 9] ?? 0
  const sampleRate = bytes.readUInt32LE(head + 12)
  if (channels !== 1) return { compatible: false, container: 'ogg', reason: '实时识别只接受单声道音频' }
  if (sampleRate <= 0) return { compatible: false, container: 'ogg', reason: 'Ogg Opus 缺少有效采样率' }
  return { compatible: true, format: 'opus', sampleRate, channels: 1, container: 'ogg' }
}

function inspectWav(bytes: Buffer): CompatibleAudio | IncompatibleAudio {
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = bytes.subarray(offset, offset + 4).toString('ascii')
    const size = bytes.readUInt32LE(offset + 4)
    if (id === 'fmt ' && offset + 24 <= bytes.length) {
      const audioFormat = bytes.readUInt16LE(offset + 8)
      const channels = bytes.readUInt16LE(offset + 10)
      const sampleRate = bytes.readUInt32LE(offset + 12)
      const bits = bytes.readUInt16LE(offset + 22)
      if (channels !== 1) return { compatible: false, container: 'wav', reason: '实时识别只接受单声道音频' }
      if (audioFormat !== 1 || bits !== 16) {
        return { compatible: false, container: 'wav', reason: 'WAV 必须是 16-bit PCM' }
      }
      if (sampleRate <= 0) return { compatible: false, container: 'wav', reason: 'WAV 缺少有效采样率' }
      return { compatible: true, format: 'wav', sampleRate, channels: 1, container: 'wav' }
    }
    if (size < 0) break
    offset += 8 + size + (size % 2)
  }
  return { compatible: false, container: 'wav', reason: 'WAV 缺少 fmt 块' }
}

function isWebM(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
}
