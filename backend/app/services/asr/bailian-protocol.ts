import type { AsrAudioFormat, AsrTranscriptSegment } from './asr-provider.js'

export function buildRunTaskMessage(input: {
  taskId: string
  model: string
  format: AsrAudioFormat
  sampleRate: number
}): string {
  return JSON.stringify({
    header: {
      action: 'run-task',
      task_id: input.taskId,
      streaming: 'duplex',
    },
    payload: {
      task_group: 'audio',
      task: 'asr',
      function: 'recognition',
      model: input.model,
      parameters: {
        format: input.format,
        sample_rate: input.sampleRate,
        disfluency_removal_enabled: false,
        language_hints: ['zh', 'en'],
      },
      input: {},
    },
  })
}

export function buildFinishTaskMessage(taskId: string): string {
  return JSON.stringify({
    header: {
      action: 'finish-task',
      task_id: taskId,
      streaming: 'duplex',
    },
    payload: { input: {} },
  })
}

export function readTranscriptUpdates(message: unknown): Array<{ kind: 'partial' | 'final'; segment: AsrTranscriptSegment }> {
  if (!isRecord(message)) return []
  const header = isRecord(message.header) ? message.header : null
  if (header?.event !== 'result-generated') return []
  const payload = isRecord(message.payload) ? message.payload : null
  const output = payload && isRecord(payload.output) ? payload.output : null
  if (!output) return []
  return sentencesOf(output.sentence).flatMap((sentence) => {
    const update = transcriptFromSentence(sentence)
    return update ? [update] : []
  })
}

export function readTranscriptUpdate(message: unknown): { kind: 'partial' | 'final'; segment: AsrTranscriptSegment } | null {
  return readTranscriptUpdates(message)[0] ?? null
}

export function readFinalTranscripts(message: unknown): AsrTranscriptSegment[] {
  return readTranscriptUpdates(message).flatMap((update) => update.kind === 'final' ? [update.segment] : [])
}

export function readServerEventName(message: unknown): string | null {
  if (!isRecord(message) || !isRecord(message.header)) return null
  return typeof message.header.event === 'string' ? message.header.event : null
}

export function readServerError(message: unknown): string | null {
  if (!isRecord(message) || !isRecord(message.header)) return null
  if (message.header.event !== 'task-failed') return null
  return typeof message.header.error_message === 'string' ? message.header.error_message : '语音识别失败'
}

function transcriptFromSentence(sentence: Record<string, unknown>): { kind: 'partial' | 'final'; segment: AsrTranscriptSegment } | null {
  if (sentence.heartbeat === true) return null
  const text = typeof sentence.text === 'string' ? sentence.text.trim() : ''
  const startTimeMs = finiteNumber(sentence.begin_time)
  if (!text || startTimeMs === null) return null
  const start = Math.round(startTimeMs)
  const endTimeMs = resolveEndTime(sentence, start)
  if (endTimeMs === null || endTimeMs < start) return null
  const speaker = sentence.speaker_id
  const speakerId = typeof speaker === 'string' && speaker.trim()
    ? speaker.trim()
    : typeof speaker === 'number' && Number.isFinite(speaker)
      ? String(speaker)
      : null
  return {
    kind: sentence.sentence_end === true ? 'final' : 'partial',
    segment: { text, startTimeMs: start, endTimeMs, speakerId },
  }
}

function resolveEndTime(sentence: Record<string, unknown>, startTimeMs: number): number | null {
  const direct = finiteNumber(sentence.end_time)
  if (direct !== null) return Math.round(direct)
  const words = Array.isArray(sentence.words) ? sentence.words : []
  let last: number | null = null
  for (const word of words) {
    if (!isRecord(word)) continue
    const end = finiteNumber(word.end_time)
    if (end !== null) last = end
  }
  if (last !== null) return Math.max(startTimeMs, Math.round(last))
  return startTimeMs
}

function sentencesOf(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord)
  return isRecord(value) ? [value] : []
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
