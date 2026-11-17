import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'

const directory = await mkdtemp(join(tmpdir(), 'xiaodou-asr-push-'))
process.env.DATABASE_PATH = join(directory, 'verify.db')
process.env.RECORDING_DIR = join(directory, 'recordings')

const { config } = await import('../app/core/config.js')
const { initializeDatabase } = await import('../app/db/initialize-database.js')
const { prepareDirectories } = await import('../app/core/prepare-directories.js')
const { closeDatabaseConnection } = await import('../app/db/connection.js')
const { attachRecordingStreams } = await import('../app/api/recording-stream.js')
const { createApp } = await import('../app/app.js')
const { RecordingService } = await import('../app/services/recording-service.js')
const { TaskExecutor } = await import('../app/services/task-executor.js')

const report: Record<string, unknown> = {
  asrConfigured: config.asrApiKey.trim().length > 0,
  llmConfigured: config.llmApiKey.trim().length > 0,
}

if (!report.asrConfigured) {
  console.log(JSON.stringify({ ...report, verified: false, reason: 'ASR_API_KEY is empty' }))
  process.exitCode = 2
} else {
  const wavPath = join(directory, 'speech.wav')
  await synthesize(wavPath, '你好，这是一段测试录音')
  const wav = await readFile(wavPath)
  const decoded = decodeWav(wav)
  const pcm = decoded.channels === 1 ? decoded.pcm : downmix(decoded.pcm, decoded.channels)
  const silence = Buffer.alloc(decoded.sampleRate * 2 * 1.5)
  const audio = Buffer.concat([pcm, silence])
  await prepareDirectories({ ...config, recordingDir: process.env.RECORDING_DIR })
  initializeDatabase()
  const recordings = new RecordingService({ recordingDir: process.env.RECORDING_DIR })
  const app = createApp({ recordingService: recordings })
  const server = app.listen(0, '127.0.0.1')
  attachRecordingStreams(server, recordings)
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const created = recordings.create({ requestId: 'verify-push', title: '实时推送验证' })
  const recordingId = created.recording.id
  await recordings.start(recordingId)
  const received: Array<{ at: number; type: string }> = []
  const started = Date.now()
  let finishSentAt: number | null = null
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/recordings/${recordingId}/stream`)
  const messages = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket verification timed out')), 30_000)
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.on('message', (data) => {
      const event = JSON.parse(data.toString()) as { type?: string }
      received.push({ at: Date.now() - started, type: event.type ?? 'unknown' })
      if (event.type === 'session.completed' || (event.type === 'asr.error' && finishSentAt !== null)) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
  socket.send(JSON.stringify({ type: 'session.start', sampleRate: decoded.sampleRate, channels: 1, encoding: 'pcm_s16le' }))
  const frameBytes = Math.floor(decoded.sampleRate / 10) * 2
  let sequence = 0
  for (let offset = 0; offset < audio.length; offset += frameBytes) {
    const frame = audio.subarray(offset, Math.min(audio.length, offset + frameBytes))
    const payload = Buffer.alloc(8 + frame.length)
    payload.writeUInt32LE(sequence, 0)
    payload.writeUInt32LE(Math.round(offset / 2 / decoded.sampleRate * 1000), 4)
    frame.copy(payload, 8)
    socket.send(payload)
    sequence += 1
    await delay(100)
  }
  await delay(1000)
  const beforeFinish = received.map((event) => event.type)
  finishSentAt = Date.now() - started
  socket.send(JSON.stringify({ type: 'session.finish' }))
  let finishError: string | null = null
  try {
    await messages
  } catch (error: unknown) {
    finishError = error instanceof Error ? error.message : 'finish failed'
  }
  const detail = recordings.get(recordingId)
  const liveSegments = detail.segments.filter((segment) => segment.audioSequence !== null)
  let taskStatus: string | null = detail.task?.status ?? null
  let summaryCreated = Boolean(detail.summary?.content)
  let knowledgePointCount = recordings.listKnowledgePoints(recordingId).length
  if (liveSegments.length > 0 && detail.task) {
    const executor = new TaskExecutor()
    await executor.processAvailableTasks()
    const after = recordings.get(recordingId)
    taskStatus = after.task?.status ?? null
    summaryCreated = Boolean(after.summary?.content)
    knowledgePointCount = recordings.listKnowledgePoints(recordingId).length
  }
  report.sampleRate = decoded.sampleRate
  report.framesSent = sequence
  report.audioBytes = detail.chunks.reduce((total, chunk) => total + chunk.byteSize, 0)
  report.eventsBeforeFinish = beforeFinish
  report.finishSentAtMs = finishSentAt
  report.events = received
  report.liveFinalsBeforeFinish = beforeFinish.filter((type) => type === 'transcript.final').length
  report.partialsBeforeFinish = beforeFinish.filter((type) => type === 'transcript.partial').length
  report.storedSegments = detail.segments.length
  report.liveStoredSegments = liveSegments.length
  report.transcript = detail.segments.map((segment) => segment.content).join('')
  report.sessionCompleted = received.some((event) => event.type === 'session.completed')
  report.finishError = finishError
  report.taskStatus = taskStatus
  report.summaryCreated = summaryCreated
  report.knowledgePointCount = knowledgePointCount
  report.audioRemains = detail.chunks.length > 0 && detail.chunks.every((chunk) => chunk.byteSize > 0)
  console.log(`VERIFY ${JSON.stringify(report)}`)
  socket.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  closeDatabaseConnection()
}

await rm(directory, { recursive: true, force: true })

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function synthesize(path: string, text: string): Promise<void> {
  const script = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SetOutputToWaveFile('${path.replaceAll('\\', '\\\\')}')
$synth.Speak('${text}')
$synth.Dispose()
`
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`speech synthesis exited ${code}`)))
  })
}

function decodeWav(wav: Buffer): { pcm: Buffer; sampleRate: number; channels: number } {
  let offset = 12
  let sampleRate = 0
  let channels = 0
  let pcm = Buffer.alloc(0)
  while (offset + 8 <= wav.length) {
    const id = wav.subarray(offset, offset + 4).toString('ascii')
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'fmt ' && offset + 22 <= wav.length) {
      channels = wav.readUInt16LE(offset + 10)
      sampleRate = wav.readUInt32LE(offset + 12)
    }
    if (id === 'data') {
      pcm = wav.subarray(offset + 8, offset + 8 + size)
      break
    }
    offset += 8 + size + (size % 2)
  }
  if (!sampleRate || !channels || pcm.length === 0) throw new Error('invalid wav')
  return { pcm, sampleRate, channels }
}

function downmix(pcm: Buffer, channels: number): Buffer {
  const samples = Math.floor(pcm.length / 2 / channels)
  const mono = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index += 1) {
    let total = 0
    for (let channel = 0; channel < channels; channel += 1) {
      total += pcm.readInt16LE((index * channels + channel) * 2)
    }
    mono.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(total / channels))), index * 2)
  }
  return mono
}
