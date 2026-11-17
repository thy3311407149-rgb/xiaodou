class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0]
    const first = channels?.[0]
    if (!first || first.length === 0) return true
    const mono = new Float32Array(first.length)
    const count = channels.length
    for (let index = 0; index < first.length; index += 1) {
      let sum = 0
      for (let channel = 0; channel < count; channel += 1) sum += channels[channel]?.[index] ?? 0
      mono[index] = sum / count
    }
    this.port.postMessage(mono)
    return true
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor)
