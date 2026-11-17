export type RecordingStatus = 'CREATED' | 'RECORDING' | 'PAUSED' | 'INTERRUPTED' | 'ENDED' | 'DELETED'
export type AudioAsrStatus = 'SKIPPED' | 'SUCCEEDED' | 'FAILED'

export type Recording = {
  id: string
  title: string
  status: RecordingStatus
  mimeType: string | null
  sampleRate: number | null
  startedAt: string | null
  endedAt: string | null
  interruptedAt: string | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

export type RecordingAudioChunk = {
  id: string
  recordingId: string
  sequence: number
  storagePath: string
  byteSize: number
  sha256: string
  mimeType: string
  asrStatus: AudioAsrStatus
  createdAt: string
}

export type TranscriptSegment = {
  id: string
  recordingId: string
  segmentIndex: number
  audioSequence: number | null
  content: string
  startTimeMs: number
  endTimeMs: number
  speakerId: string | null
  createdAt: string
}

export type KnowledgePoint = {
  id: string
  knowledgeItemId: string
  recordingId: string
  sourceSegmentId: string | null
  content: string
  startTimeMs: number | null
  endTimeMs: number | null
  speakerId: string | null
  createdAt: string
}
