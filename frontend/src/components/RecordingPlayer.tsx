import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { fetchRecordingChunkAudio, type RecordingChunk } from '../api/recordings.ts'
import { formatClock } from '../recording/clock.ts'
import { pcmToWav } from '../recording/realtime.ts'

const RATES = [1, 1.25, 1.5, 2]
const BAR_COUNT = 48

function isPcmMime(mime: string): boolean {
  const value = mime.toLowerCase()
  return value.includes('pcm') || value.includes('l16')
}

function barHeight(index: number): number {
  const mid = Math.abs(index - BAR_COUNT / 2) / (BAR_COUNT / 2)
  const envelope = 0.45 + 0.55 * (1 - mid * mid)
  return Math.max(6, Math.round((8 + Math.sin(index * 0.55) * 10) * envelope))
}

export function RecordingPlayer({
  recordingId,
  chunks,
  durationSec,
  sampleRate = null,
}: {
  recordingId: string
  chunks: RecordingChunk[]
  durationSec: number | null
  sampleRate?: number | null
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [rateIndex, setRateIndex] = useState(0)
  const [duration, setDuration] = useState(durationSec ?? 0)
  const [message, setMessage] = useState<string | null>(chunks.length === 0 ? '没有可播放的音频' : null)
  const ratio = duration > 0 ? Math.min(1, current / duration) : 0

  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
  }, [])

  async function ensureAudio(): Promise<HTMLAudioElement | null> {
    if (chunks.length === 0) return null
    if (audioRef.current && urlRef.current) return audioRef.current
    const ordered = [...chunks].sort((left, right) => left.sequence - right.sequence)
    const parts: Blob[] = []
    for (const chunk of ordered) parts.push(await fetchRecordingChunkAudio(recordingId, chunk.sequence))
    const pcm = ordered.every((chunk) => isPcmMime(chunk.mimeType))
    if (pcm) {
      if (!sampleRate || sampleRate <= 0) throw new Error('pcm sample rate')
      const bytes = new Uint8Array(parts.reduce((total, part) => total + part.size, 0))
      let offset = 0
      for (const part of parts) {
        bytes.set(new Uint8Array(await part.arrayBuffer()), offset)
        offset += part.size
      }
      const url = URL.createObjectURL(pcmToWav(bytes, sampleRate))
      urlRef.current = url
      return bindAudio(url)
    }
    const type = parts.find((part) => part.type)?.type || ordered[0]?.mimeType || 'audio/webm'
    const url = URL.createObjectURL(new Blob(parts, { type }))
    urlRef.current = url
    return bindAudio(url)
  }

  function bindAudio(url: string): HTMLAudioElement {
    const audio = new Audio(url)
    audioRef.current = audio
    audio.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(audio.duration)) setDuration(audio.duration)
    })
    audio.addEventListener('timeupdate', () => setCurrent(audio.currentTime))
    audio.addEventListener('ended', () => {
      setPlaying(false)
      setCurrent(audio.duration || 0)
    })
    return audio
  }

  async function toggle(): Promise<void> {
    if (chunks.length === 0) return
    try {
      const audio = await ensureAudio()
      if (!audio) return
      if (playing) {
        audio.pause()
        setPlaying(false)
        return
      }
      audio.playbackRate = RATES[rateIndex] ?? 1
      await audio.play()
      setPlaying(true)
      setMessage(null)
    } catch {
      setPlaying(false)
      setMessage('录音暂时无法播放')
    }
  }

  function setRate(): void {
    const next = (rateIndex + 1) % RATES.length
    setRateIndex(next)
    if (audioRef.current) audioRef.current.playbackRate = RATES[next] ?? 1
  }

  function seek(event: PointerEvent<HTMLDivElement>): void {
    const audio = audioRef.current
    if (!audio || duration <= 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const ratioNext = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    audio.currentTime = ratioNext * duration
    setCurrent(audio.currentTime)
  }

  const playedBars = Math.floor(ratio * BAR_COUNT)
  return (
    <div className="vd-player">
      <div className="vd-wave-wrap" onPointerDown={(event) => seek(event)}>
        <div className="vd-wave">
          {Array.from({ length: BAR_COUNT }, (_, index) => (
            <span className={`vd-bar ${index <= playedBars ? 'played' : ''}`} key={index} style={{ height: barHeight(index) }} />
          ))}
        </div>
        <div className="vd-playhead" />
      </div>
      <div className="vd-ctrl">
        <div className="vd-time">{formatClock(current)}</div>
        <div className="vd-ctrl-right">
          <button className="vd-speed" type="button" onClick={setRate}>{RATES[rateIndex]}x</button>
          <button className="vd-play" type="button" aria-label={playing ? '暂停播放' : '播放'} disabled={chunks.length === 0} onClick={() => void toggle()}>
            {playing
              ? <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
              : <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5L8 5.5z" /></svg>}
          </button>
        </div>
      </div>
      {message && <p className="record-note">{message}</p>}
    </div>
  )
}
