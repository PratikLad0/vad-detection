import './App.css'
import { useEffect, useRef, useState } from 'react'

type RecorderState = 'idle' | 'listening' | 'recording' | 'uploading' | 'done' | 'error'
type VadClass = 'silence' | 'noise' | 'speech'

type SpeechSegment = {
  start: number
  end: number
  duration: number
}

const BACKEND_URL = 'http://localhost:8000'

function App() {
  // High-level recorder state (upload / error tracking)
  const [, setState] = useState<RecorderState>('idle')
  const [statusText, setStatusText] = useState(
    'Say "Hey AI" to start speaking (your browser may ask for microphone access).',
  )
  const [lastFilename, setLastFilename] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [segments, setSegments] = useState<SpeechSegment[]>([])

  // Live VAD / energy monitor
  const [vadClass, setVadClass] = useState<VadClass>('silence')
  const [energyLevel, setEnergyLevel] = useState(0) // 0–1 normalized
  const [wakeMode, setWakeMode] = useState(false)
  const [wakeStatus, setWakeStatus] = useState<'idle' | 'listening' | 'triggered' | 'unsupported'>('idle')

  const mediaStreamRef = useRef<MediaStream | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafIdRef = useRef<number | null>(null)
  const chunksRef = useRef<Blob[]>([])

  // VAD params
  const speakingRef = useRef(false)
  const lastSpeechTimeRef = useRef<number>(0)
  const sessionStartRef = useRef<number | null>(null)
  const currentSpeechStartRef = useRef<number | null>(null)
  const wakeTriggeredRef = useRef(false)
  // Narrow SpeechRecognition types with minimal surface to avoid any
  type MinimalRecognition = {
    continuous: boolean
    interimResults: boolean
    lang: string
    start: () => void
    stop: () => void
    onstart: (() => void) | null
    onerror: ((e: unknown) => void) | null
    onend: (() => void) | null
    onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  } | null
  const recognitionRef = useRef<MinimalRecognition>(null)

  const reset = () => {
    setState('idle')
    setStatusText('Say "Hey AI" to start speaking (your browser may ask for microphone access).')
    setError(null)
    setSegments([])
    setVadClass('silence')
    setEnergyLevel(0)
    setWakeMode(false)
    setWakeStatus('idle')
    wakeTriggeredRef.current = false

    // Stop recognition if running
    try {
      recognitionRef.current?.stop()
    } catch {
      // ignore
    }
    recognitionRef.current = null
  }

  const cleanup = () => {
    if (rafIdRef.current != null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }

    analyserRef.current?.disconnect()
    analyserRef.current = null

    audioContextRef.current?.close()
    audioContextRef.current = null

    mediaStreamRef.current?.getTracks().forEach((t) => t.stop())
    mediaStreamRef.current = null

    mediaRecorderRef.current?.stop()
    mediaRecorderRef.current = null

    speakingRef.current = false
    setVadClass('silence')
    setEnergyLevel(0)
    setWakeStatus('idle')
    wakeTriggeredRef.current = false

    try {
      recognitionRef.current?.stop()
    } catch {
      // ignore
    }
    recognitionRef.current = null
  }

  // Auto-start wake word mode once, ignoring exhaustive-deps for this initializer.
  useEffect(() => {
    void startWakeWordMode()
    return () => {
      cleanup()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Start wake-word mode (one-time permission + continuous standby)
  const startWakeWordMode = async () => {
    try {
      setError(null)
      setLastFilename(null)
      setSegments([])
      setWakeMode(true)
      setWakeStatus('idle')
      setStatusText('Requesting microphone for wake word...')
      setState('listening')

      sessionStartRef.current = performance.now()

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaStreamRef.current = stream

      const audioContext = new AudioContext()
      audioContextRef.current = audioContext

      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 2048
      analyserRef.current = analyser
      source.connect(analyser)

      const mediaRecorder = new MediaRecorder(stream)
      mediaRecorderRef.current = mediaRecorder

      chunksRef.current = []
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data)
        }
      }
      mediaRecorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        chunksRef.current = []
        await uploadRecording(blob)
        // In wake mode, remain active and wait for next wake trigger
        speakingRef.current = false
        setStatusText('Waiting for wake word: say "Hey AI"...')
        setState('listening')
        wakeTriggeredRef.current = false
      }

      // Thresholds
      const SILENCE_DURATION_MS = 1500
      const SILENCE_RMS = 0.005
      const SPEECH_RMS = 0.03
      const VOICE_THRESHOLD = SPEECH_RMS

      const data = new Float32Array(analyser.fftSize)

      const loop = () => {
        analyser.getFloatTimeDomainData(data)

        let sum = 0
        for (let i = 0; i < data.length; i++) {
          const v = data[i]
          sum += v * v
        }
        const rms = Math.sqrt(sum / data.length)

        const normalized = Math.min(rms / SPEECH_RMS, 1)
        setEnergyLevel(normalized)

        let frameClass: VadClass
        if (rms < SILENCE_RMS) {
          frameClass = 'silence'
        } else if (rms < SPEECH_RMS) {
          frameClass = 'noise'
        } else {
          frameClass = 'speech'
        }
        setVadClass(frameClass)

        const now = performance.now()

        // Gate recording on wake trigger while in wake mode
        if (wakeMode && !wakeTriggeredRef.current) {
          // Do not start recording yet; just keep updating visuals
          rafIdRef.current = requestAnimationFrame(loop)
          return
        }

        if (rms > VOICE_THRESHOLD) {
          lastSpeechTimeRef.current = now
          if (!speakingRef.current) {
            // Speech just started
            speakingRef.current = true
            currentSpeechStartRef.current = now
            setStatusText('Speech detected, recording...')
            setState('recording')
            if (mediaRecorder.state !== 'recording') {
              mediaRecorder.start()
            }
          }
        } else if (speakingRef.current) {
          const silenceMs = now - lastSpeechTimeRef.current
          if (silenceMs > SILENCE_DURATION_MS) {
            // Speech just ended
            speakingRef.current = false

            const segmentStart = currentSpeechStartRef.current ?? lastSpeechTimeRef.current
            const segmentEnd = now
            const base = sessionStartRef.current ?? segmentStart

            const startSec = (segmentStart - base) / 1000
            const endSec = (segmentEnd - base) / 1000
            const durationSec = (segmentEnd - segmentStart) / 1000

            console.log('Speech segment timing:', {
              startSecondsFromSessionStart: startSec,
              endSecondsFromSessionStart: endSec,
              durationSeconds: durationSec,
            })

            setSegments((prev) => [
              ...prev,
              {
                start: startSec,
                end: endSec,
                duration: durationSec,
              },
            ])

            setStatusText('Silence detected, stopping...')
            if (mediaRecorder.state === 'recording') {
              mediaRecorder.stop()
            }
            // In wake mode, do NOT cleanup; keep listening
            if (!wakeMode) {
              cleanup()
              return
            }
          }
        }

        rafIdRef.current = requestAnimationFrame(loop)
      }

      rafIdRef.current = requestAnimationFrame(loop)

      // Initialize browser SpeechRecognition for wake word
      type SRCtor = new () => {
        continuous: boolean
        interimResults: boolean
        lang: string
        start: () => void
        stop: () => void
        onstart: (() => void) | null
        onerror: ((e: unknown) => void) | null
        onend: (() => void) | null
        onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
      }
      const SpeechRecognition =
        (window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor })
          .SpeechRecognition ||
        (window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor })
          .webkitSpeechRecognition
      if (!SpeechRecognition) {
        setWakeStatus('unsupported')
        setStatusText('Wake word unsupported on this browser; use the button to record.')
      } else {
        const recognition: MinimalRecognition = new SpeechRecognition()
        recognitionRef.current = recognition
        recognition.continuous = true
        recognition.interimResults = true
        recognition.lang = 'en-US'
        recognition.onstart = () => {
          setWakeStatus('listening')
          setStatusText('Say "Hey AI" to start speaking...')
        }
        recognition.onerror = (e: unknown) => {
          console.warn('SpeechRecognition error', e)
        }
        recognition.onend = () => {
          // Keep it running in wake mode
          if (wakeMode) {
            try {
              recognition.start()
            } catch {
              // ignore restart errors
            }
          }
        }
        recognition.onresult = (event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => {
          let transcript = ''
          for (let i = event.resultIndex; i < event.results.length; i++) {
            transcript += event.results[i][0]?.transcript || ''
          }
          const lower = transcript.toLowerCase()
          // Simple variants to catch "hey ai"
          const matched =
            lower.includes('hey ai') ||
            lower.includes('hey a i') ||
            lower.includes('hey, ai') ||
            lower.includes('hey aye') ||
            lower.includes('hey eye')
          if (matched && !wakeTriggeredRef.current) {
            wakeTriggeredRef.current = true
            setWakeStatus('triggered')
            setStatusText('Wake word detected. Speak your message...')
          }
        }
        try {
          recognition.start()
        } catch {
          // ignore startup race
        }
      }
    } catch (err: unknown) {
      console.error(err)
      reset()
      const message = err instanceof Error ? err.message : 'Failed to start wake word mode'
      setError(message)
      setStatusText('Could not start wake word mode.')
      setState('error')
      cleanup()
    }
  }

  // Legacy manual mode removed entirely; wake word mode is the default path.

  const uploadRecording = async (blob: Blob) => {
    try {
      setState('uploading')
      setStatusText('Uploading recording to backend...')
      const formData = new FormData()
      formData.append('file', blob, 'recording.webm')

      const res = await fetch(`${BACKEND_URL}/upload`, {
        method: 'POST',
        body: formData,
      })

      if (!res.ok) {
        throw new Error(`Upload failed with status ${res.status}`)
      }

      const data = await res.json()
      setLastFilename(data.filename)
      if (wakeMode) {
        // Stay in wake mode and keep listening for the next trigger
        setState('listening')
        setStatusText('Recording uploaded. Say "Hey AI" again when you are ready.')
      } else {
        setStatusText('Recording uploaded successfully.')
        setState('done')
      }
    } catch (err: unknown) {
      console.error(err)
      reset()
      const message = err instanceof Error ? err.message : 'Upload failed'
      setError(message)
      setStatusText('Upload failed.')
      setState('error')
    }
  }

  const vadLabel =
    vadClass === 'silence' ? 'Silence' : vadClass === 'noise' ? 'Noise' : 'Speech'
  const wakeLabel =
    wakeStatus === 'listening'
      ? 'Wake: Listening'
      : wakeStatus === 'triggered'
      ? 'Wake: Triggered'
      : wakeStatus === 'unsupported'
      ? 'Wake: Unsupported'
      : 'Wake: Idle'

  return (
    <div className="app">
      <div className="card">
        <h1 className="title">VAD-based WebRTC Recorder</h1>
        <p className="subtitle">
          Starts recording when you speak, stops when you are silent, and uploads to a Python backend.
        </p>

        <p className="status">{statusText}</p>

        <div className="monitor">
          <div className="monitor-header">
            <span className="monitor-title">Live VAD monitor</span>
            <span className={`vad-badge vad-${vadClass}`}>{vadLabel}</span>
          </div>
          <div className="monitor-header" style={{ marginTop: '0.25rem' }}>
            <span className="monitor-title">Wake status</span>
            <span className="vad-badge">{wakeLabel}</span>
          </div>
          <div className="meter-bar">
            <div
              className={`meter-fill vad-${vadClass}`}
              style={{ width: `${Math.round(energyLevel * 100)}%` }}
            />
          </div>
          <div className="meter-scale">
            <span>Silence</span>
            <span>Noise</span>
            <span>Speech</span>
          </div>
        </div>

        {error && <p className="error">Error: {error}</p>}

        {lastFilename && (
          <div className="result">
            <p>
              Saved on server as: <code>{lastFilename}</code>
            </p>
          </div>
        )}

        {segments.length > 0 && (
          <div className="result">
            <p>Speech timing (relative to when you clicked "Start listening"):</p>
            <ul>
              {segments.map((s, idx) => (
                <li key={idx}>
                  Segment {idx + 1}: start {s.start.toFixed(2)}s, end {s.end.toFixed(2)}s, duration{' '}
                  {s.duration.toFixed(2)}s
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <footer className="footer">
        <span>
          Frontend: WebRTC + Web Audio VAD {wakeMode ? '· Wake word active' : ''} · Backend:
          FastAPI
        </span>
      </footer>
    </div>
  )
}

export default App
