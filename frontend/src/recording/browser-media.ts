import type { RecordingClock, RecordingMedia, RecorderHandle } from './session.ts'
import { connectRecordingSocket, floatToPcm16, frameSampleCount, recordingStreamUrl, SampleBuffer, type PcmSource } from './realtime.ts'

function hasAudioWorklet(): boolean {
  const Context = globalThis.AudioContext
  return typeof Context === 'function' && 'audioWorklet' in Context.prototype
}

export function browserRecordingMedia(): RecordingMedia {
  const RecorderCtor = globalThis.MediaRecorder
  return {
    pcmAvailable: hasAudioWorklet(),
    recorderAvailable: typeof RecorderCtor === 'function',
    getUserMedia(constraints) {
      const devices = navigator.mediaDevices
      if (!devices?.getUserMedia) return Promise.reject(new TypeError('getUserMedia'))
      return devices.getUserMedia(constraints)
    },
    isTypeSupported(mime) {
      return typeof RecorderCtor?.isTypeSupported === 'function' && RecorderCtor.isTypeSupported(mime)
    },
    createRecorder(stream, mime) {
      return new RecorderCtor(stream as MediaStream, { mimeType: mime }) as RecorderHandle
    },
    createPcmSource(stream) {
      return createBrowserPcmSource(stream as MediaStream)
    },
    createSocket(recordingId) {
      return connectRecordingSocket(recordingStreamUrl(recordingId, window.location))
    },
  }
}

export function browserRecordingClock(): RecordingClock {
  return {
    now: () => Date.now(),
    setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimer: (id) => window.clearTimeout(id),
  }
}

export async function createBrowserPcmSource(stream: MediaStream): Promise<PcmSource> {
  const context = new AudioContext()
  await context.audioWorklet.addModule('/pcm-capture-processor.js')
  const sampleRate = context.sampleRate
  const node = new AudioWorkletNode(context, 'pcm-capture')
  const source = context.createMediaStreamSource(stream)
  const mute = context.createGain()
  mute.gain.value = 0
  source.connect(node)
  node.connect(mute)
  mute.connect(context.destination)
  const buffer = new SampleBuffer(frameSampleCount(sampleRate))
  let onFrame: ((pcm: Uint8Array) => void) | null = null
  let accepting = false
  let stopped = false
  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (!accepting || !(event.data instanceof Float32Array) || event.data.length === 0) return
    for (const frame of buffer.push(floatToPcm16(event.data))) onFrame?.(frame)
  }
  return {
    sampleRate,
    start(callback) {
      onFrame = callback
      accepting = true
      void context.resume()
    },
    pause() {
      accepting = false
      void context.suspend()
      return buffer.flush()
    },
    resume() {
      if (stopped) return
      accepting = true
      void context.resume()
    },
    async stop() {
      if (stopped) return new Uint8Array()
      stopped = true
      accepting = false
      const tail = buffer.flush()
      node.port.onmessage = null
      node.disconnect()
      source.disconnect()
      mute.disconnect()
      await context.close()
      return tail
    },
  }
}
