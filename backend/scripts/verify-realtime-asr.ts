import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const directory = await mkdtemp(join(tmpdir(), 'xiaodou-asr-verify-'))
process.env.DATABASE_PATH = join(directory, 'verify.db')
process.env.RECORDING_DIR = join(directory, 'recordings')

const { config } = await import('../app/core/config.js')
const { initializeDatabase } = await import('../app/db/initialize-database.js')
const { prepareDirectories } = await import('../app/core/prepare-directories.js')
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
  report.container = 'wav'
  report.declaredFormat = 'pcm_s16le'
  report.channels = decoded.channels
  report.sampleRate = decoded.sampleRate
  report.downmixed = decoded.channels !== 1
  const pcm = decoded.channels === 1 ? decoded.pcm : downmix(decoded.pcm, decoded.channels)
  await writeFile(join(directory, 'speech.pcm'), pcm)

  await prepareDirectories({ ...config, recordingDir: process.env.RECORDING_DIR })
  initializeDatabase()
  const recordings = new RecordingService({ recordingDir: process.env.RECORDING_DIR })
  const partials: string[] = []
  const finals: Array<{ text: string; beginTime: number; endTime: number }> = []
  const created = recordings.create({ requestId: 'verify-asr', title: 'ASR验证' })
  recordings.bindNotice(created.recording.id, (event) => {
    if (event.type === 'transcript.partial') partials.push(event.text)
    if (event.type === 'transcript.final') finals.push({ text: event.text, beginTime: event.beginTime, endTime: event.endTime })
  })
  await recordings.start(created.recording.id)
  await recordings.openPcmStream(created.recording.id, decoded.sampleRate)
  const frameBytes = decoded.sampleRate * 2 / 5
  for (let offset = 0, sequence = 0; offset < pcm.length; offset += frameBytes, sequence += 1) {
    const frame = pcm.subarray(offset, Math.min(pcm.length, offset + frameBytes))
    const audio = frame.length % 2 === 0 ? frame : frame.subarray(0, frame.length - 1)
    if (audio.length === 0) continue
    await recordings.appendChunk(created.recording.id, {
      sequence,
      audio: Buffer.from(audio),
      mimeType: 'audio/pcm',
      sampleRate: decoded.sampleRate,
    })
  }
  const stored = recordings.get(created.recording.id)
  report.audioFiles = stored.chunks.length
  report.audioBytes = stored.chunks.reduce((total, chunk) => total + chunk.byteSize, 0)
  report.audioRemainsBeforeFinish = stored.chunks.every((chunk) => chunk.byteSize > 0)
  let taskStatus: string | null = null
  let taskError: string | null = null
  try {
    const finished = await recordings.finish(created.recording.id, 'verify-asr')
    const executor = new TaskExecutor()
    await executor.processAvailableTasks()
    const task = recordings.get(created.recording.id).task
    taskStatus = task?.status ?? finished.task.status
    taskError = task?.errorCode ?? null
  } catch (error: unknown) {
    taskError = error instanceof Error ? error.message : 'finish failed'
  }
  const detail = recordings.get(created.recording.id)
  report.partialCount = partials.length
  report.finalCount = Math.max(finals.length, detail.segments.length)
  report.transcript = detail.segments.map((segment) => segment.content).join('')
  report.timestamps = detail.segments.map((segment) => ({ beginTime: segment.startTimeMs, endTime: segment.endTimeMs }))
  report.taskStatus = taskStatus
  report.taskError = taskError
  report.summaryCreated = Boolean(detail.summary?.content)
  report.knowledgePointCount = recordings.listKnowledgePoints(created.recording.id).length
  report.audioRemains = detail.chunks.length > 0
  console.log(JSON.stringify(report))
  const { closeDatabaseConnection } = await import('../app/db/connection.js')
  closeDatabaseConnection()
}

await rm(directory, { recursive: true, force: true })

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
