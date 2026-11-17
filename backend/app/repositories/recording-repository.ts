import type Database from 'better-sqlite3'
import { getDatabaseConnection } from '../db/connection.js'
import type { TaskStatus } from '../models/task.js'
import type { AudioAsrStatus, KnowledgePoint, Recording, RecordingAudioChunk, RecordingStatus, TranscriptSegment } from '../models/recording.js'

export type RecordingListItem = {
  recordingId: string
  title: string
  createdAt: string
  durationMs: number | null
  status: RecordingStatus
  processingStatus: TaskStatus | null
  summaryGenerated: boolean
}

type RecordingRow = {
  id: string
  title: string
  status: RecordingStatus
  mime_type: string | null
  sample_rate: number | null
  started_at: string | null
  ended_at: string | null
  interrupted_at: string | null
  error_code: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

type ChunkRow = {
  id: string
  recording_id: string
  sequence: number
  storage_path: string
  byte_size: number
  sha256: string
  mime_type: string
  asr_status: AudioAsrStatus
  created_at: string
}

type SegmentRow = {
  id: string
  recording_id: string
  segment_index: number
  audio_sequence: number | null
  content: string
  start_time_ms: number
  end_time_ms: number
  speaker_id: string | null
  created_at: string
}

type RecordingListRow = {
  id: string
  title: string
  status: RecordingStatus
  created_at: string
  mime_type: string | null
  sample_rate: number | null
  audio_bytes: number
  transcript_end_ms: number | null
  processing_status: string | null
  summary_generated: number
}

type PointRow = {
  id: string
  knowledge_item_id: string
  recording_id: string
  source_segment_id: string | null
  content: string
  start_time_ms: number | null
  end_time_ms: number | null
  speaker_id: string | null
  created_at: string
}

export class RecordingRepository {
  constructor(private readonly database: Database.Database = getDatabaseConnection()) {}

  create(input: { id: string; title: string }): Recording {
    this.database.prepare(`INSERT INTO recordings (id, title, status) VALUES (?, ?, 'CREATED')`).run(input.id, input.title)
    return this.findById(input.id) as Recording
  }

  listPage(limit: number, offset: number): { items: RecordingListItem[]; total: number } {
    const total = this.database.prepare(`
      SELECT COUNT(*) AS total FROM recordings WHERE status != 'DELETED'
    `).get() as { total: number }
    const rows = this.database.prepare(`
      SELECT
        r.id,
        r.title,
        r.status,
        r.created_at,
        r.mime_type,
        r.sample_rate,
        COALESCE((
          SELECT SUM(byte_size) FROM recording_audio_chunks WHERE recording_id = r.id
        ), 0) AS audio_bytes,
        (
          SELECT MAX(end_time_ms) FROM transcript_segments WHERE recording_id = r.id
        ) AS transcript_end_ms,
        (
          SELECT status FROM tasks
          WHERE recording_id = r.id
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        ) AS processing_status,
        CASE WHEN EXISTS (
          SELECT 1
          FROM knowledge_items ki
          INNER JOIN knowledge_item_summaries kis ON kis.knowledge_item_id = ki.id
          WHERE ki.source_type = 'RECORDING' AND ki.source_id = r.id
        ) THEN 1 ELSE 0 END AS summary_generated
      FROM recordings r
      WHERE r.status != 'DELETED'
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as RecordingListRow[]
    return { total: total.total, items: rows.map((row) => this.toListItem(row)) }
  }

  findById(id: string): Recording | null {
    const row = this.database.prepare('SELECT * FROM recordings WHERE id = ?').get(id) as RecordingRow | undefined
    return row ? this.toRecording(row) : null
  }

  update(id: string, input: Partial<Pick<Recording, 'status' | 'mimeType' | 'sampleRate' | 'startedAt' | 'endedAt' | 'interruptedAt' | 'errorCode' | 'errorMessage'>>): Recording | null {
    const assignments: string[] = []
    const parameters: Record<string, unknown> = { id, updatedAt: new Date().toISOString() }
    const fields: Array<[keyof typeof input, string]> = [
      ['status', 'status'],
      ['mimeType', 'mime_type'],
      ['sampleRate', 'sample_rate'],
      ['startedAt', 'started_at'],
      ['endedAt', 'ended_at'],
      ['interruptedAt', 'interrupted_at'],
      ['errorCode', 'error_code'],
      ['errorMessage', 'error_message'],
    ]
    for (const [property, column] of fields) {
      if (input[property] !== undefined) {
        assignments.push(`${column} = @${property}`)
        parameters[property] = input[property]
      }
    }
    assignments.push('updated_at = @updatedAt')
    this.database.prepare(`UPDATE recordings SET ${assignments.join(', ')} WHERE id = @id`).run(parameters)
    return this.findById(id)
  }

  markInterrupted(message: string): number {
    const now = new Date().toISOString()
    const result = this.database.prepare(`
      UPDATE recordings
      SET status = 'INTERRUPTED', interrupted_at = @now, error_message = @message, updated_at = @now
      WHERE status = 'RECORDING'
    `).run({ now, message })
    return result.changes
  }

  delete(id: string): void {
    this.database.prepare('DELETE FROM recordings WHERE id = ?').run(id)
  }

  listChunks(recordingId: string): RecordingAudioChunk[] {
    const rows = this.database.prepare('SELECT * FROM recording_audio_chunks WHERE recording_id = ? ORDER BY sequence ASC').all(recordingId) as ChunkRow[]
    return rows.map((row) => this.toChunk(row))
  }

  insertChunk(input: Omit<RecordingAudioChunk, 'createdAt'>): RecordingAudioChunk {
    this.database.prepare(`
      INSERT INTO recording_audio_chunks (id, recording_id, sequence, storage_path, byte_size, sha256, mime_type, asr_status)
      VALUES (@id, @recordingId, @sequence, @storagePath, @byteSize, @sha256, @mimeType, @asrStatus)
    `).run(input)
    return this.listChunks(input.recordingId).find((chunk) => chunk.id === input.id) as RecordingAudioChunk
  }

  updateChunkAsrStatus(id: string, asrStatus: AudioAsrStatus): void {
    this.database.prepare('UPDATE recording_audio_chunks SET asr_status = ? WHERE id = ?').run(asrStatus, id)
  }

  listSegments(recordingId: string): TranscriptSegment[] {
    const rows = this.database.prepare('SELECT * FROM transcript_segments WHERE recording_id = ? ORDER BY segment_index ASC').all(recordingId) as SegmentRow[]
    return rows.map((row) => this.toSegment(row))
  }

  appendSegments(inputs: Array<Omit<TranscriptSegment, 'createdAt'>>): void {
    const insert = this.database.prepare(`
      INSERT INTO transcript_segments (
        id, recording_id, segment_index, audio_sequence, content, start_time_ms, end_time_ms, speaker_id
      ) VALUES (
        @id, @recordingId, @segmentIndex, @audioSequence, @content, @startTimeMs, @endTimeMs, @speakerId
      )
    `)
    const write = this.database.transaction((rows: Array<Omit<TranscriptSegment, 'createdAt'>>) => {
      for (const row of rows) insert.run(row)
    })
    write(inputs)
  }

  replaceSegments(recordingId: string, inputs: Array<Omit<TranscriptSegment, 'createdAt' | 'recordingId'>>): TranscriptSegment[] {
    const replace = this.database.transaction(() => {
      this.database.prepare('DELETE FROM transcript_segments WHERE recording_id = ?').run(recordingId)
      this.appendSegments(inputs.map((input) => ({ ...input, recordingId })))
    })
    replace()
    return this.listSegments(recordingId)
  }

  replaceKnowledgePoints(recordingId: string, inputs: Array<Omit<KnowledgePoint, 'createdAt' | 'recordingId'>>): KnowledgePoint[] {
    const insert = this.database.prepare(`
      INSERT INTO knowledge_points (
        id, knowledge_item_id, recording_id, source_segment_id, content, start_time_ms, end_time_ms, speaker_id
      ) VALUES (
        @id, @knowledgeItemId, @recordingId, @sourceSegmentId, @content, @startTimeMs, @endTimeMs, @speakerId
      )
    `)
    const replace = this.database.transaction(() => {
      this.database.prepare('DELETE FROM knowledge_points WHERE recording_id = ?').run(recordingId)
      for (const input of inputs) insert.run({ ...input, recordingId })
    })
    replace()
    return this.listKnowledgePoints(recordingId)
  }

  listKnowledgePoints(recordingId: string): KnowledgePoint[] {
    const rows = this.database.prepare('SELECT * FROM knowledge_points WHERE recording_id = ? ORDER BY created_at ASC').all(recordingId) as PointRow[]
    return rows.map((row) => ({
      id: row.id,
      knowledgeItemId: row.knowledge_item_id,
      recordingId: row.recording_id,
      sourceSegmentId: row.source_segment_id,
      content: row.content,
      startTimeMs: row.start_time_ms,
      endTimeMs: row.end_time_ms,
      speakerId: row.speaker_id,
      createdAt: row.created_at,
    }))
  }

  private toListItem(row: RecordingListRow): RecordingListItem {
    return {
      recordingId: row.id,
      title: row.title,
      createdAt: row.created_at,
      durationMs: recordingDurationMs(row),
      status: row.status,
      processingStatus: isTaskStatus(row.processing_status) ? row.processing_status : null,
      summaryGenerated: row.summary_generated === 1,
    }
  }

  private toRecording(row: RecordingRow): Recording {
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      mimeType: row.mime_type,
      sampleRate: row.sample_rate,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      interruptedAt: row.interrupted_at,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private toChunk(row: ChunkRow): RecordingAudioChunk {
    return {
      id: row.id,
      recordingId: row.recording_id,
      sequence: row.sequence,
      storagePath: row.storage_path,
      byteSize: row.byte_size,
      sha256: row.sha256,
      mimeType: row.mime_type,
      asrStatus: row.asr_status,
      createdAt: row.created_at,
    }
  }

  private toSegment(row: SegmentRow): TranscriptSegment {
    return {
      id: row.id,
      recordingId: row.recording_id,
      segmentIndex: row.segment_index,
      audioSequence: row.audio_sequence,
      content: row.content,
      startTimeMs: row.start_time_ms,
      endTimeMs: row.end_time_ms,
      speakerId: row.speaker_id,
      createdAt: row.created_at,
    }
  }
}

function recordingDurationMs(row: Pick<RecordingListRow, 'mime_type' | 'sample_rate' | 'audio_bytes' | 'transcript_end_ms'>): number | null {
  if (isTimedPcm(row.mime_type) && row.sample_rate && row.sample_rate > 0 && row.audio_bytes > 0) {
    return Math.round((row.audio_bytes / 2) / row.sample_rate * 1000)
  }
  return row.transcript_end_ms
}

function isTimedPcm(mimeType: string | null): boolean {
  if (!mimeType) return true
  const mime = mimeType.toLowerCase()
  return mime.includes('pcm') || mime.includes('l16') || mime.includes('raw')
}

function isTaskStatus(value: string | null): value is TaskStatus {
  return value === 'QUEUED' || value === 'RUNNING' || value === 'SUCCEEDED' || value === 'FAILED'
}
