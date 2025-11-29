import { useEffect, useRef, useState } from 'react'
import { logger } from './utils/logger'
import { config } from './config'
import { uploadFile, sendTranscriptionText, getRecordings, getTranscriptionLogs, getTranscriptionLogContent, downloadAudioFile, type Recording, type TranscriptionLog, type TranscriptionLogContent } from './utils/api'

type RecorderState = 'idle' | 'listening' | 'recording' | 'uploading' | 'done' | 'error'
type VadClass = 'silence' | 'noise' | 'speech'

type SpeechSegment = {
  start: number
  end: number
  duration: number
}

type LogSource = 'system' | 'wake' | 'vad' | 'upload'
type LogEntry = {
  id: number
  timestamp: string
  source: LogSource
  message: string
  meta?: string
}


function App() {
  // High-level recorder state (upload / error tracking)
  const [state, setState] = useState<RecorderState>('idle')
  const [statusText, setStatusText] = useState(
    'Checking microphone permission...',
  )
  const [lastFilename, setLastFilename] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [segments, setSegments] = useState<SpeechSegment[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [transcription, setTranscription] = useState<string>('')
  const [completeTranscription, setCompleteTranscription] = useState<string>('') // Accumulated transcription
  const [showLogs, setShowLogs] = useState<boolean>(true)
  const [saveTextFile, setSaveTextFile] = useState<boolean>(false)
  const saveTextFileRef = useRef<boolean>(false)
  const [sessionId, setSessionId] = useState<string>('')
  const sessionIdRef = useRef<string>('')
  const [isTTSPlaying, setIsTTSPlaying] = useState<boolean>(false)
  const [isAudioPlaying, setIsAudioPlaying] = useState<boolean>(false)
  const [lastAudioBlob, setLastAudioBlob] = useState<Blob | null>(null)
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [transcriptionLogs, setTranscriptionLogs] = useState<TranscriptionLog[]>([])
  const [loadingRecordings, setLoadingRecordings] = useState<boolean>(false)
  const [loadingLogs, setLoadingLogs] = useState<boolean>(false)
  const [viewingLogContent, setViewingLogContent] = useState<TranscriptionLogContent | null>(null)
  const [loadingLogContent, setLoadingLogContent] = useState<boolean>(false)
  const [playingRecording, setPlayingRecording] = useState<string | null>(null)

  // Live VAD / energy monitor
  const [vadClass, setVadClass] = useState<VadClass>('silence')
  const [energyLevel, setEnergyLevel] = useState(0) // 0–1 normalized
  const [wakeMode, setWakeMode] = useState(false)
  const [wakeStatus, setWakeStatus] = useState<'idle' | 'listening' | 'triggered' | 'unsupported'>('idle')
  // True after "Hey AI" has been detected at least once; after that, VAD alone can start recordings.
  const [wakeEverTriggered, setWakeEverTriggered] = useState(false)
  // Tracks browser microphone permission state (if Permissions API is available).
  const [micPermission, setMicPermission] = useState<'unknown' | 'granted' | 'prompt' | 'denied'>(
    'unknown',
  )

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
  // Single source of truth for whether wake-word mode is active (used inside long-lived closures).
  const wakeModeRef = useRef(false)
  const wakeEverTriggeredRef = useRef(false)
  const nextLogIdRef = useRef(1)
  const wakeWordStoppedPromiseRef = useRef<Promise<void> | null>(null)
  const wakeWordStoppedResolverRef = useRef<(() => void) | null>(null)
  const wakeWordIntentionallyStoppedRef = useRef<boolean>(false)
  // SpeechRecognition state tracking
  const recognitionRunningRef = useRef(false)
  const recognitionRetryTimeoutRef = useRef<number | null>(null)
  const transcriptionRestartTimeoutRef = useRef<number | null>(null)
  const transcriptionRestartCountRef = useRef<number>(0)
  const isTranscriptionStartingRef = useRef<boolean>(false)
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
  const transcriptionRecognitionRef = useRef<MinimalRecognition>(null)
  const transcriptionRef = useRef<string>('')
  const ttsUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null)
  const lastAudioBlobRef = useRef<Blob | null>(null)
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null)
  const isAudioPlayingRef = useRef<boolean>(false)
  const isTTSPlayingRef = useRef<boolean>(false)

  const addLog = (source: LogSource, message: string, meta?: string) => {
    setLogs((prev) => {
      const now = new Date()
      const timestamp = now.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
      const entry: LogEntry = {
        id: nextLogIdRef.current++,
        timestamp,
        source,
        message,
        meta,
      }
      // Keep most recent logs at the top, cap at 50
      return [entry, ...prev].slice(0, 50)
    })
  }

  const reset = () => {
    setState('idle')
        setStatusText('Click "Start listening" to enable the microphone, then say "Hey AI" or "start".')
    setError(null)
    setSegments([])
    setLogs([])
    setTranscription('')
    transcriptionRef.current = ''
    setVadClass('silence')
    setEnergyLevel(0)
    setWakeMode(false)
    wakeModeRef.current = false
    setWakeStatus('idle')
    wakeTriggeredRef.current = false
    wakeEverTriggeredRef.current = false
    setWakeEverTriggered(false)

    // Stop recognition if running
    try {
      recognitionRef.current?.stop()
    } catch {
      // ignore
    }
    recognitionRef.current = null
    recognitionRunningRef.current = false
    if (recognitionRetryTimeoutRef.current != null) {
      clearTimeout(recognitionRetryTimeoutRef.current)
      recognitionRetryTimeoutRef.current = null
    }
    // Stop transcription recognition
    try {
      transcriptionRecognitionRef.current?.stop()
    } catch {
      // ignore
    }
    transcriptionRecognitionRef.current = null
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
    wakeEverTriggeredRef.current = false

    try {
      recognitionRef.current?.stop()
    } catch {
      // ignore
    }
    recognitionRef.current = null
    recognitionRunningRef.current = false
    if (recognitionRetryTimeoutRef.current != null) {
      clearTimeout(recognitionRetryTimeoutRef.current)
      recognitionRetryTimeoutRef.current = null
    }
    // Stop transcription recognition
    try {
      transcriptionRecognitionRef.current?.stop()
    } catch {
      // ignore
    }
    transcriptionRecognitionRef.current = null
    // Don't clear transcription - keep it visible after recording completes
  }

  // Sync saveTextFileRef with saveTextFile state
  useEffect(() => {
    saveTextFileRef.current = saveTextFile
  }, [saveTextFile])

  // Sync sessionIdRef with sessionId state
  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  // Generate session ID immediately on component mount (before any other effects)
  // This ensures sessionId is available from the start
  useEffect(() => {
    const generateSessionId = () => {
      const timestamp = Date.now()
      const random = Math.random().toString(36).substring(2, 9)
      return `session-${timestamp}-${random}`
    }
    const newSessionId = generateSessionId()
    // Set both state and ref immediately
    setSessionId(newSessionId)
    sessionIdRef.current = newSessionId
    logger.info('Session ID generated on page load', { sessionId: newSessionId })
    console.log('🟢 Session ID generated on page load:', newSessionId)
  }, []) // Empty dependency array - only run once on mount

  useEffect(() => {
    const checkPermissionAndMaybeStart = async () => {
      try {
        const navAny = navigator as unknown as {
          permissions?: {
            query: (opts: { name: 'microphone' | PermissionName }) => Promise<PermissionStatus>
          }
        }
        if (navAny.permissions?.query) {
          const status = await navAny.permissions.query({ name: 'microphone' })
          const state = status.state as 'granted' | 'prompt' | 'denied'
          setMicPermission(state)
          if (state === 'granted') {
            setStatusText('Say "Hey AI" or "start" to begin recording.')
            addLog('system', 'Microphone permission already granted on load')
            await startWakeWordMode()
            return
          }
          if (state === 'prompt') {
            setStatusText('Click "Start listening" to allow microphone, then say "Hey AI" or "start".')
            addLog('system', 'Microphone permission will be requested when user clicks Start')
          } else if (state === 'denied') {
            setStatusText('Microphone access is blocked. Please enable it in browser settings.')
            addLog('system', 'Microphone permission denied at browser level')
          }
        } else {
          // Permissions API not available; fall back to manual start.
          setMicPermission('unknown')
          setStatusText('Click "Start listening" to enable the microphone, then say "Hey AI" or "start".')
          addLog('system', 'Permissions API unavailable, falling back to manual Start listening')
        }
      } catch {
        setMicPermission('unknown')
        setStatusText('Click "Start listening" to enable the microphone, then say "Hey AI" or "start".')
        addLog('system', 'Error while checking microphone permission, using manual Start listening')
      }
    }

    void checkPermissionAndMaybeStart()

    return () => {
      cleanup()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Fetch recordings and logs when Event Log is opened, and also on component mount
  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoadingRecordings(true)
        const recordingsData = await getRecordings()
        setRecordings(recordingsData)
      } catch (err) {
        logger.error('Failed to fetch recordings', err)
      } finally {
        setLoadingRecordings(false)
      }

      if (showLogs) {
        try {
          setLoadingLogs(true)
          const logsData = await getTranscriptionLogs()
          setTranscriptionLogs(logsData)
        } catch (err) {
          logger.error('Failed to fetch transcription logs', err)
        } finally {
          setLoadingLogs(false)
        }
      }
    }

    fetchData()
    
    // Refresh recordings periodically (every 30 seconds)
    const interval = setInterval(() => {
      getRecordings()
        .then(setRecordings)
        .catch((err) => logger.error('Failed to refresh recordings', err))
    }, 30000)

    return () => clearInterval(interval)
  }, [showLogs])

  // Start wake-word mode (one-time permission + continuous standby)
  const startWakeWordMode = async () => {
    try {
      setError(null)
      setLastFilename(null)
      setSegments([])
      setWakeMode(true)
      wakeModeRef.current = true
      setWakeStatus('idle')
      setStatusText('Requesting microphone for wake word...')
      setState('listening')
      addLog('system', 'Starting wake-word mode, requesting microphone')

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
        const currentSessionId = sessionIdRef.current || sessionId
        logger.info('MediaRecorder stopped', { 
          chunksCount: chunksRef.current.length,
          saveTextFile: saveTextFileRef.current,
          sessionId: currentSessionId,
          sessionIdFromRef: sessionIdRef.current,
          sessionIdFromState: sessionId
        })
        console.log('🔵 MediaRecorder stopped', {
          sessionId: currentSessionId,
          saveTextFile: saveTextFileRef.current
        })
        
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        chunksRef.current = []
        
        // Only store audio blob if not in text-only mode
        if (!saveTextFileRef.current) {
          setLastAudioBlob(blob)
          lastAudioBlobRef.current = blob
        } else {
          // Clear audio blob in text-only mode
          setLastAudioBlob(null)
          lastAudioBlobRef.current = null
        }
        
        // Save the final transcription from this recording session to complete transcription
        // This preserves all transcriptions across multiple recording sessions
        const currentTranscription = transcriptionRef.current || transcription
        logger.info('MediaRecorder onstop - transcription state', {
          transcriptionRef: transcriptionRef.current?.substring(0, 50),
          transcriptionState: transcription.substring(0, 50),
          hasTranscription: !!currentTranscription.trim(),
          sessionId: currentSessionId
        })
        
        // Add this recording's transcription to the accumulated complete transcription
        // The real-time transcription field will be cleared on the next recording start
        if (currentTranscription.trim()) {
          setCompleteTranscription(prev => {
            const newText = prev ? `${prev}\n\n${currentTranscription}` : currentTranscription
            return newText
          })
        }
        
        logger.info('Calling uploadRecording', { 
          blobSize: blob.size,
          saveTextFile: saveTextFileRef.current,
          sessionId: currentSessionId,
          sessionIdFromRef: sessionIdRef.current,
          sessionIdFromState: sessionId,
          hasTranscription: !!currentTranscription.trim()
        })
        console.log('🔵 Calling uploadRecording with sessionId:', currentSessionId)
        await uploadRecording(blob)
        
        // Play TTS after upload completes
        if (currentTranscription.trim()) {
          playTTS(currentTranscription)
        }
        
        // In wake mode, remain active and wait for next wake trigger
        speakingRef.current = false
        setStatusText('Waiting for wake word: say "Hey AI" or "start"...')
        setState('listening')
        wakeTriggeredRef.current = false
        
        // Restart wake word recognition after recording completes
        if (wakeModeRef.current && recognitionRef.current && !recognitionRunningRef.current) {
          try {
            console.log('🟢 Restarting wake word recognition after recording completed')
            recognitionRef.current.start()
          } catch (err) {
            console.warn('⚠️ Failed to restart wake word recognition', err)
          }
        }
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

        // Gate recording on wake trigger while in wake mode:
        // 1) Before the first "Hey AI": never record (only monitor).
        // 2) After "Hey AI" has been detected once, rely purely on VAD speech to start recording.
        if (wakeModeRef.current && !wakeEverTriggeredRef.current && !wakeTriggeredRef.current) {
          // Wake word not detected yet – only monitor.
          rafIdRef.current = requestAnimationFrame(loop)
          return
        }

        if (rms > VOICE_THRESHOLD) {
          lastSpeechTimeRef.current = now
          if (!speakingRef.current) {
            // Completely ignore speech when TTS/audio is playing - no barge-in, no recording
            if (isTTSPlayingRef.current || isAudioPlayingRef.current) {
              // Ignore all speech while TTS/audio is playing to prevent microphone picking up speaker audio
              rafIdRef.current = requestAnimationFrame(loop)
              return
            }
            
            speakingRef.current = true
            currentSpeechStartRef.current = now
            setStatusText('Speech detected, recording...')
            setState('recording')
            addLog('vad', 'Speech detected, starting recording')
            
            if (mediaRecorder.state !== 'recording') {
              // Only clear transcription if this is a new speech session (wake word just detected)
              // Don't clear if MediaRecorder is restarting due to silence/TTS
              const isNewSpeechSession = !transcriptionRef.current || transcriptionRef.current.length === 0
              
              if (isNewSpeechSession) {
                // New speech session - clear transcription
                setTranscription('')
                transcriptionRef.current = ''
                logger.info('Starting MediaRecorder - new speech session, transcription cleared', { 
                  saveTextFile: saveTextFileRef.current,
                  sessionId
                })
                console.log('🟢 Starting new recording - new speech session, transcription cleared', {
                  textOnlyMode: saveTextFileRef.current,
                  note: 'MediaRecorder works in both modes - needed for transcription'
                })
              } else {
                // Continuing existing speech session - keep transcription
                logger.info('Starting MediaRecorder - continuing speech session, transcription preserved', { 
                  saveTextFile: saveTextFileRef.current,
                  sessionId,
                  existingTranscriptionLength: transcriptionRef.current.length
                })
                console.log('🟢 Starting new recording - continuing speech session, transcription preserved', {
                  textOnlyMode: saveTextFileRef.current,
                  existingTranscriptionLength: transcriptionRef.current.length,
                  note: 'MediaRecorder works in both modes - needed for transcription'
                })
              }
              try {
                mediaRecorder.start()
                console.log('✅ MediaRecorder.start() called', {
                  state: mediaRecorder.state,
                  timestamp: new Date().toISOString()
                })
                // Verify MediaRecorder actually started
                setTimeout(() => {
                  console.log('🔍 MediaRecorder state check after start', {
                    state: mediaRecorder.state,
                    expectedState: 'recording',
                    isRecording: mediaRecorder.state === 'recording'
                  })
                }, 50)
              } catch (err) {
                console.error('❌ Failed to start MediaRecorder', err)
                logger.error('Failed to start MediaRecorder', err)
                return
              }
              
              console.log('🟢 MediaRecorder started, starting transcription in 1000ms...', {
                textOnlyMode: saveTextFileRef.current,
                note: 'MediaRecorder works in both modes - needed for transcription. Longer delay to ensure wake word recognition is fully stopped.'
              })
              // Start transcription - add longer delay to ensure wake word recognition is fully stopped
              // and MediaRecorder is ready. The browser needs time to release SpeechRecognition service.
              // NOTE: MediaRecorder must stay active in text-only mode for transcription to work
              // Use the local mediaRecorder variable (not ref) since we know it's recording
              setTimeout(() => {
                const currentState = mediaRecorder.state
                const mediaRecorderFromRef = mediaRecorderRef.current
                console.log('🟢 Calling startTranscription() after delay', {
                  mediaRecorderState: currentState,
                  mediaRecorderFromRefState: mediaRecorderFromRef?.state,
                  isRecording: currentState === 'recording',
                  speakingRef: speakingRef.current,
                  textOnlyMode: saveTextFileRef.current,
                  usingLocalMediaRecorder: true
                })
                // MediaRecorder must be recording for transcription to work (in both normal and text-only mode)
                // Use the local mediaRecorder variable which we know is recording
                if (currentState === 'recording') {
                  // Pass the mediaRecorder state to startTranscription to avoid ref timing issues
                  startTranscription(mediaRecorder)
                } else {
                  console.error('❌ Cannot start transcription - MediaRecorder not recording', {
                    state: currentState,
                    refState: mediaRecorderFromRef?.state,
                    speakingRef: speakingRef.current,
                    textOnlyMode: saveTextFileRef.current,
                    note: 'MediaRecorder should be recording in both modes for transcription'
                  })
                  logger.error('Cannot start transcription - MediaRecorder not recording', {
                    state: currentState,
                    refState: mediaRecorderFromRef?.state
                  })
                  setError('MediaRecorder stopped unexpectedly. Cannot start transcription.')
                }
              }, 1000) // Increased delay to ensure wake word recognition is fully stopped
            }
          }
        } else if (speakingRef.current) {
          // Don't process silence/stop recording if TTS is playing
          if (isTTSPlayingRef.current || isAudioPlayingRef.current) {
            rafIdRef.current = requestAnimationFrame(loop)
            return
          }
          
          const silenceMs = now - lastSpeechTimeRef.current
          if (silenceMs > SILENCE_DURATION_MS) {
            // Speech just ended
            console.log('🟡 Silence detected, speech ending', {
              silenceMs,
              mediaRecorderState: mediaRecorder.state,
              timestamp: new Date().toISOString()
            })
            speakingRef.current = false

            const segmentStart = currentSpeechStartRef.current ?? lastSpeechTimeRef.current
            const segmentEnd = now
            const base = sessionStartRef.current ?? segmentStart

            const startSec = (segmentStart - base) / 1000
            const endSec = (segmentEnd - base) / 1000
            const durationSec = (segmentEnd - segmentStart) / 1000

            logger.debug('Speech segment timing', {
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
            addLog('vad', 'Speech ended, stopping recording', `Duration ${durationSec.toFixed(2)}s`)

            setStatusText('Silence detected, stopping...')
            if (mediaRecorder.state === 'recording') {
              logger.info('Stopping recording due to silence', {
                saveTextFile: saveTextFileRef.current,
                currentTranscription: transcriptionRef.current?.substring(0, 50),
                sessionId
              })
              // Stop transcription and wait for final results before stopping recorder
              stopTranscription().then(() => {
                // Additional delay to ensure transcription is fully processed
                setTimeout(() => {
                  if (mediaRecorder.state === 'recording') {
                    logger.info('Stopping MediaRecorder', { sessionId })
                    mediaRecorder.stop()
                  } else {
                    logger.warn('MediaRecorder not in recording state when trying to stop', {
                      state: mediaRecorder.state,
                      sessionId
                    })
                  }
                }, 300)
              }).catch((err) => {
                logger.error('Error stopping transcription', err)
                // Still try to stop the recorder even if transcription stop failed
                if (mediaRecorder.state === 'recording') {
                  mediaRecorder.stop()
                }
              })
            } else {
              logger.warn('MediaRecorder not recording when silence detected', {
                state: mediaRecorder.state,
                sessionId
              })
            }
            // In wake mode, do NOT cleanup; keep listening
            if (!wakeModeRef.current) {
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
        addLog('wake', 'Wake word unsupported on this browser')
      } else {
        const recognition: MinimalRecognition = new SpeechRecognition()
        recognitionRef.current = recognition
        recognition.continuous = true
        recognition.interimResults = true
        recognition.lang = 'en-US'
        recognition.onstart = () => {
          recognitionRunningRef.current = true
          setWakeStatus('listening')
          setStatusText('Say "Hey AI" or "start" to begin recording...')
          addLog('wake', 'Wake-word recognition started, waiting for "Hey AI" or "start"')
          // Clear any pending retry
          if (recognitionRetryTimeoutRef.current != null) {
            clearTimeout(recognitionRetryTimeoutRef.current)
            recognitionRetryTimeoutRef.current = null
          }
        }
        recognition.onerror = (e: unknown) => {
          recognitionRunningRef.current = false
          // Type guard for SpeechRecognitionErrorEvent
          const errorEvent = e as { error?: string; message?: string } | null
          const errorType = errorEvent?.error || 'unknown'
          const errorMsg = errorEvent?.message || ''

          // 'aborted' is usually harmless - service restarting
          if (errorType === 'aborted') {
            // Silently handle - will restart in onend
            return
          }

          // 'no-speech' is also usually harmless
          if (errorType === 'no-speech') {
            return
          }

          // Log other errors
          addLog('wake', `Recognition error: ${errorType}`, errorMsg || undefined)

          // For serious errors, retry with backoff
          if (errorType === 'network' || errorType === 'service-not-allowed') {
            if (wakeModeRef.current && recognitionRetryTimeoutRef.current == null) {
              addLog('wake', 'Retrying recognition in 2 seconds...')
              recognitionRetryTimeoutRef.current = window.setTimeout(() => {
                recognitionRetryTimeoutRef.current = null
                if (wakeModeRef.current && !recognitionRunningRef.current) {
                  try {
                    recognition.start()
                  } catch {
                    addLog('wake', 'Failed to restart recognition after error')
                  }
                }
              }, 2000)
            }
          } else if (errorType === 'not-allowed') {
            addLog('wake', 'Microphone permission denied for recognition')
            setWakeStatus('unsupported')
          }
        }
        recognition.onend = () => {
          recognitionRunningRef.current = false
          console.log('🟡 Wake word recognition onend event fired', {
            wakeMode: wakeModeRef.current,
            intentionallyStopped: wakeWordIntentionallyStoppedRef.current,
            timestamp: new Date().toISOString()
          })
          // Resolve the promise if we're waiting for wake word to stop
          if (wakeWordStoppedResolverRef.current) {
            console.log('✅ Resolving wake word stopped promise')
            wakeWordStoppedResolverRef.current()
            wakeWordStoppedResolverRef.current = null
            wakeWordStoppedPromiseRef.current = null
          }
          // Don't auto-restart if we intentionally stopped it for transcription
          if (wakeWordIntentionallyStoppedRef.current) {
            console.log('🟡 Wake word intentionally stopped - not auto-restarting')
            wakeWordIntentionallyStoppedRef.current = false
            return // Don't restart - transcription will handle restarting it later
          }
          // Keep it running in wake mode with a small delay to avoid race conditions
          if (wakeModeRef.current && recognitionRetryTimeoutRef.current == null) {
            recognitionRetryTimeoutRef.current = window.setTimeout(() => {
              recognitionRetryTimeoutRef.current = null
              if (wakeModeRef.current && !recognitionRunningRef.current) {
            try {
              recognition.start()
            } catch {
                  // If start fails, retry after a longer delay
                  recognitionRetryTimeoutRef.current = window.setTimeout(() => {
                    recognitionRetryTimeoutRef.current = null
                    if (wakeModeRef.current && !recognitionRunningRef.current) {
            try {
              recognition.start()
            } catch {
                        addLog('wake', 'Failed to restart recognition')
                      }
                    }
                  }, 1000)
                }
              }
            }, 100) // Small delay to avoid immediate restart
          }
        }
        recognition.onresult = async (event: {
          resultIndex: number
          results: ArrayLike<ArrayLike<{ transcript: string }>>
        }) => {
          // Stop processing wake word detection if already triggered
          if (wakeTriggeredRef.current) {
            return
          }

          let transcript = ''
          for (let i = event.resultIndex; i < event.results.length; i++) {
            transcript += event.results[i][0]?.transcript || ''
          }
          const lower = transcript.toLowerCase().trim()

          // Check for standalone "start" wake word (must be at the beginning or after a short pause)
          const startMatch = lower.match(/^\s*start\s*$|^\s*start\s+/)
          if (startMatch) {
            logger.debug('[WakeWord] "Start" detected – stopping wake word detection and arming VAD')
            wakeTriggeredRef.current = true
            setWakeEverTriggered(true)
            wakeEverTriggeredRef.current = true
            setWakeStatus('triggered')
            setStatusText('Wake word "start" detected. Speak your message...')
            addLog('wake', 'Wake word "start" detected, VAD armed', lower)
            
            // Stop wake word recognition - transcription will start when speech is detected
            if (recognitionRef.current && recognitionRunningRef.current) {
              try {
                console.log('🟡 Stopping wake word recognition after "start" detected')
                // Mark that we're intentionally stopping it (prevents auto-restart)
                wakeWordIntentionallyStoppedRef.current = true
                // Create a promise that resolves when wake word recognition fully stops
                if (!wakeWordStoppedPromiseRef.current) {
                  wakeWordStoppedPromiseRef.current = new Promise<void>((resolve) => {
                    wakeWordStoppedResolverRef.current = resolve
                  })
                }
                const wakeRecognition = recognitionRef.current
                wakeRecognition.stop()
                recognitionRunningRef.current = false
                console.log('🟡 Wake word recognition stop() called, waiting for onend event...')
                // Wait for the onend event to fire (with timeout as fallback)
                await Promise.race([
                  wakeWordStoppedPromiseRef.current,
                  new Promise(resolve => setTimeout(resolve, 1500)) // Fallback timeout
                ])
                console.log('✅ Wake word recognition should be fully stopped now')
              } catch (err) {
                console.warn('⚠️ Failed to stop wake word recognition', err)
              }
            }
            return
          }

          // Check for "Hey AI" variants
          const hasHeyAi =
            lower.includes('hey ai') ||
            lower.includes('hey, ai') ||
            lower.includes('hey  ai') ||
            lower.includes('hey a i') ||
            lower.includes('hey eye') ||
            lower.includes('hey aye')

          if (!hasHeyAi) {
            return
          }

          // Find the position of "hey ai" in the transcript
          const heyIndex = lower.search(/hey\s*[,]?\s*a\s*i|hey\s*eye|hey\s*aye/)
          const heyNearStart = heyIndex === -1 || heyIndex < 30 // More lenient position check

          if (!heyNearStart) {
            // Don't log if wake word already triggered
            return
          }

          // Intent detection
          const intentKeywords = [
            "let's",
            'lets',
            'talk',
            'chat',
            'conversation',
            'question',
            'ask',
            'help',
            'begin',
            'can you',
            'please',
          ]
          const hasIntent = intentKeywords.some((k) => lower.includes(k))

          // "Hey AI" works without intent, but log if intent is present
          if (hasIntent) {
            logger.debug('[WakeWord] "Hey AI" + intent detected – stopping wake word detection and arming VAD')
            wakeTriggeredRef.current = true
            setWakeEverTriggered(true)
            wakeEverTriggeredRef.current = true
            setWakeStatus('triggered')
            setStatusText('Wake word "Hey AI" detected. Speak your message...')
            addLog('wake', 'Wake word "Hey AI" + intent detected, VAD armed', lower)
            
            // Stop wake word recognition - transcription will start when speech is detected
            if (recognitionRef.current && recognitionRunningRef.current) {
              try {
                console.log('🟡 Stopping wake word recognition after "Hey AI" detected')
                // Mark that we're intentionally stopping it (prevents auto-restart)
                wakeWordIntentionallyStoppedRef.current = true
                // Create a promise that resolves when wake word recognition fully stops
                if (!wakeWordStoppedPromiseRef.current) {
                  wakeWordStoppedPromiseRef.current = new Promise<void>((resolve) => {
                    wakeWordStoppedResolverRef.current = resolve
                  })
                }
                const wakeRecognition = recognitionRef.current
                wakeRecognition.stop()
                recognitionRunningRef.current = false
                console.log('🟡 Wake word recognition stop() called, waiting for onend event...')
                // Wait for the onend event to fire (with timeout as fallback)
                await Promise.race([
                  wakeWordStoppedPromiseRef.current,
                  new Promise(resolve => setTimeout(resolve, 1500)) // Fallback timeout
                ])
                console.log('✅ Wake word recognition should be fully stopped now')
              } catch (err) {
                console.warn('⚠️ Failed to stop wake word recognition', err)
              }
            }
          } else {
            // "Hey AI" without intent still works, but log it
            logger.debug('[WakeWord] "Hey AI" detected (no intent keywords) – stopping wake word detection and arming VAD')
            wakeTriggeredRef.current = true
            setWakeEverTriggered(true)
            wakeEverTriggeredRef.current = true
            setWakeStatus('triggered')
            setStatusText('Wake word "Hey AI" detected. Speak your message...')
            addLog('wake', 'Wake word "Hey AI" detected, VAD armed', lower)
            // Clear transcription for new speech session when wake word is detected
            setTranscription('')
            transcriptionRef.current = ''
            logger.info('Wake word detected - transcription cleared for new speech session')
            
            // Stop wake word recognition - transcription will start when speech is detected
            if (recognitionRef.current && recognitionRunningRef.current) {
              try {
                console.log('🟡 Stopping wake word recognition after "Hey AI" detected (no intent)')
                // Mark that we're intentionally stopping it (prevents auto-restart)
                wakeWordIntentionallyStoppedRef.current = true
                // Create a promise that resolves when wake word recognition fully stops
                if (!wakeWordStoppedPromiseRef.current) {
                  wakeWordStoppedPromiseRef.current = new Promise<void>((resolve) => {
                    wakeWordStoppedResolverRef.current = resolve
                  })
                }
                const wakeRecognition = recognitionRef.current
                wakeRecognition.stop()
                recognitionRunningRef.current = false
                console.log('🟡 Wake word recognition stop() called, waiting for onend event...')
                // Wait for the onend event to fire (with timeout as fallback)
                await Promise.race([
                  wakeWordStoppedPromiseRef.current,
                  new Promise(resolve => setTimeout(resolve, 1500)) // Fallback timeout
                ])
                console.log('✅ Wake word recognition should be fully stopped now')
              } catch (err) {
                console.warn('⚠️ Failed to stop wake word recognition', err)
              }
            }
          }
        }
        try {
          recognition.start()
        } catch {
          // ignore startup race
        }
      }
    } catch (err: unknown) {
      logger.error('Failed to start wake word mode', err)
      reset()
      const message = err instanceof Error ? err.message : 'Failed to start wake word mode'
      setError(message)
      setStatusText('Could not start wake word mode.')
      setState('error')
      cleanup()
    }
  }

  const startTranscription = (mediaRecorderInstance?: MediaRecorder) => {
    // Start real-time speech-to-text transcription
    // This will convert the user's speech to text and display it in real-time
    // The transcription accumulates as the user speaks until speech stops
    // mediaRecorderInstance: Optional MediaRecorder instance to check state (avoids ref timing issues)
    const mediaRecorder = mediaRecorderInstance || mediaRecorderRef.current
    const currentState = mediaRecorder?.state || 'unknown'
    console.log('🟢 startTranscription() called', {
      mediaRecorderState: currentState,
      mediaRecorderExists: !!mediaRecorder,
      usingProvidedInstance: !!mediaRecorderInstance,
      speakingRef: speakingRef.current,
      wakeMode: wakeModeRef.current,
      recognitionRunning: recognitionRunningRef.current,
      hasExistingTranscription: !!transcriptionRecognitionRef.current,
      timestamp: new Date().toISOString()
    })
    logger.info('startTranscription() called', {
      mediaRecorderState: currentState,
      usingProvidedInstance: !!mediaRecorderInstance,
      speakingRef: speakingRef.current
    })
    
    // Critical check: MediaRecorder must be recording for transcription to work
    // In text-only mode, MediaRecorder still needs to be recording for transcription
    if (!mediaRecorder || mediaRecorder.state !== 'recording') {
      const errorMsg = `Cannot start transcription - MediaRecorder is not recording (state: ${currentState})`
      console.error('❌', errorMsg, {
        mediaRecorderExists: !!mediaRecorder,
        state: currentState,
        usingProvidedInstance: !!mediaRecorderInstance,
        refState: mediaRecorderRef.current?.state
      })
      logger.error(errorMsg, {
        mediaRecorderState: currentState,
        mediaRecorderExists: !!mediaRecorder,
        usingProvidedInstance: !!mediaRecorderInstance,
        speakingRef: speakingRef.current
      })
      setError(errorMsg)
      return
    }
    
    // Check if SpeechRecognition is available
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
      const errorMsg = 'Speech Recognition not supported in this browser. Please use Chrome, Edge, or Safari.'
      console.error('❌', errorMsg)
      logger.warn('Speech Recognition not supported in this browser')
      addLog('system', 'Transcription not available - browser does not support Speech Recognition API')
      setError(errorMsg)
      setStatusText('Transcription not available - please use Chrome, Edge, or Safari browser')
      return
    }
    
    console.log('🟢 SpeechRecognition API found, creating instance')

    // Stop any existing transcription
    if (transcriptionRecognitionRef.current) {
      try {
        console.log('🟡 Stopping existing transcription instance')
        transcriptionRecognitionRef.current.stop()
        transcriptionRecognitionRef.current = null
      } catch (err) {
        console.warn('⚠️ Error stopping existing transcription', err)
      }
    }

    try {
      console.log('🟢 Creating new SpeechRecognition instance for transcription')
      const transcriptionRecognition = new SpeechRecognition() as MinimalRecognition
      if (!transcriptionRecognition) {
        console.error('❌ Failed to create SpeechRecognition instance')
        logger.error('Failed to create SpeechRecognition instance')
        return
      }
      
      console.log('🟢 Configuring transcription recognition', {
        continuous: true,
        interimResults: true,
        lang: 'en-US'
      })
      transcriptionRecognitionRef.current = transcriptionRecognition
      transcriptionRecognition.continuous = true
      transcriptionRecognition.interimResults = true
      transcriptionRecognition.lang = 'en-US'

      transcriptionRecognition.onstart = () => {
        console.log('✅ Transcription started successfully', {
          sessionId,
          mediaRecorderState: mediaRecorderRef.current?.state,
          speakingRef: speakingRef.current,
          recognitionRunning: recognitionRunningRef.current,
          timestamp: new Date().toISOString()
        })
        logger.info('Transcription started successfully', {
          sessionId,
          mediaRecorderState: mediaRecorderRef.current?.state,
          speakingRef: speakingRef.current
        })
        addLog('system', 'Transcription started - listening for speech...')
        setStatusText('Transcription active - speak now...')
        // Reset restart count on successful start
        transcriptionRestartCountRef.current = 0
        isTranscriptionStartingRef.current = false
        
        // Wake word recognition should already be stopped when wake word was detected
        // But ensure it's stopped to avoid conflicts
        if (recognitionRef.current && recognitionRunningRef.current) {
          try {
            console.log('🟡 Ensuring wake word recognition is stopped for transcription')
            wakeWordIntentionallyStoppedRef.current = true // Prevent auto-restart
            const wakeRecognition = recognitionRef.current
            wakeRecognition.stop()
            recognitionRunningRef.current = false
            console.log('🟡 Wake word recognition stop() called in onstart handler')
            // Don't wait here - just ensure it's stopped
          } catch (err) {
            console.warn('⚠️ Failed to stop wake word recognition', err)
          }
        } else {
          console.log('✅ Wake word recognition already stopped (or not running)')
        }
      }

      transcriptionRecognition.onresult = (event: {
        resultIndex: number
        results: ArrayLike<ArrayLike<{ transcript: string; isFinal?: boolean }>>
      }) => {
        console.log('📝 Transcription onresult event received', {
          resultIndex: event.resultIndex,
          resultsLength: event.results.length,
          timestamp: new Date().toISOString()
        })
        
        // Build full transcript from all results in this event
        // SpeechRecognition API accumulates results, so this gives us the complete
        // transcription from the start of this recording session
        let fullTranscript = ''
        let hasFinal = false
        const transcripts: string[] = []
        
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i]
          if (result && result.length > 0) {
            const transcript = result[0]?.transcript || ''
            const isFinal = result[0]?.isFinal || false
            fullTranscript += transcript
            transcripts.push(`${transcript}${isFinal ? ' [FINAL]' : ' [interim]'}`)
            if (isFinal) {
              hasFinal = true
            }
          }
        }
        
        const newTranscript = fullTranscript.trim()
        
        console.log('📝 Transcription processed', {
          fullTranscript: newTranscript,
          length: newTranscript.length,
          hasFinal,
          resultCount: event.results.length,
          transcripts: transcripts,
          mediaRecorderState: mediaRecorderRef.current?.state,
          speakingRef: speakingRef.current
        })
        
        // Update real-time transcription display
        // This shows the live transcription as the user speaks, accumulating until speech stops
        setTranscription(newTranscript)
        transcriptionRef.current = newTranscript
        
        if (newTranscript) {
          console.log('✅ Transcription updated in UI:', {
            length: newTranscript.length,
            preview: newTranscript.substring(0, 100),
            isFinal: hasFinal
          })
          logger.info('Transcription updated', {
            length: newTranscript.length,
            preview: newTranscript.substring(0, 50),
            isFinal: hasFinal,
            resultCount: event.results.length
          })
        } else {
          console.log('🟡 Transcription event received but transcript is empty', {
            resultCount: event.results.length,
            transcripts: transcripts
          })
        }
        logger.info('Transcription updated', { 
          length: newTranscript.length, 
          preview: newTranscript.substring(0, 50),
          isFinal: hasFinal,
          resultCount: event.results.length,
          hasContent: !!newTranscript
        })
      }

      transcriptionRecognition.onerror = (e: unknown) => {
        const errorEvent = e as { error?: string; message?: string } | null
        const errorType = errorEvent?.error || 'unknown'
        const errorMessage = errorEvent?.message || ''
        
        console.error('❌ Transcription error', {
          errorType,
          errorMessage,
          mediaRecorderState: mediaRecorderRef.current?.state,
          speakingRef: speakingRef.current,
          recognitionRunning: recognitionRunningRef.current,
          transcriptionRestartCount: transcriptionRestartCountRef.current,
          timestamp: new Date().toISOString()
        })
        logger.error('Transcription error', {
          error: errorType,
          message: errorMessage,
          mediaRecorderState: mediaRecorderRef.current?.state,
          speakingRef: speakingRef.current
        })
        
        // Ignore harmless errors
        if (errorType === 'aborted' || errorType === 'no-speech') {
          console.log('⚠️ Ignoring harmless transcription error:', errorType, {
            context: {
              mediaRecorderState: mediaRecorderRef.current?.state,
              speakingRef: speakingRef.current,
              timeSinceStart: Date.now()
            }
          })
          return
        }
        
        // Log and display important errors
        logger.error('Transcription error', { error: errorType, message: errorMessage })
        addLog('system', `Transcription error: ${errorType}`, errorMessage || undefined)
        
        // Show user-friendly error messages for common issues
        if (errorType === 'not-allowed') {
          setError('Microphone permission denied for transcription. Please allow microphone access.')
          setStatusText('Microphone permission required for transcription')
        } else if (errorType === 'network') {
          setError('Network error during transcription. Please check your internet connection.')
        } else if (errorType === 'service-not-allowed') {
          setError('Speech recognition service not available. Please try again later.')
        } else {
          setError(`Transcription error: ${errorType}. ${errorMessage}`)
        }
      }

      transcriptionRecognition.onend = () => {
        console.log('🟡 Transcription ended', {
          stillSpeaking: speakingRef.current,
          isStarting: isTranscriptionStartingRef.current,
          restartCount: transcriptionRestartCountRef.current,
          mediaRecorderState: mediaRecorderRef.current?.state,
          recognitionRunning: recognitionRunningRef.current,
          currentTranscription: transcriptionRef.current?.substring(0, 50),
          timestamp: new Date().toISOString()
        })
        logger.debug('Transcription ended', {
          stillSpeaking: speakingRef.current,
          isStarting: isTranscriptionStartingRef.current,
          mediaRecorderState: mediaRecorderRef.current?.state,
          transcriptionLength: transcriptionRef.current?.length || 0
        })
        
        // Clear the starting flag
        isTranscriptionStartingRef.current = false
        
        // Don't auto-restart if we're not speaking anymore (recording stopped)
        // Also check if MediaRecorder is still recording
        const mediaRecorder = mediaRecorderRef.current
        const isStillRecording = speakingRef.current && mediaRecorder && mediaRecorder.state === 'recording'
        
        if (!isStillRecording) {
          console.log('🟡 Not restarting transcription - speech/recording has stopped', {
            stillSpeaking: speakingRef.current,
            mediaRecorderState: mediaRecorder?.state
          })
          transcriptionRestartCountRef.current = 0
          // Don't restart wake word recognition here - let it restart naturally when needed
          // (e.g., when user manually triggers it or when recording completes)
          return
        }
        
        // Auto-restart if we're still recording, but add delay and limit retries
        if (isStillRecording && transcriptionRecognitionRef.current && !isTranscriptionStartingRef.current) {
          // Limit restart attempts to prevent infinite loops
          if (transcriptionRestartCountRef.current >= 5) {
            console.warn('⚠️ Too many transcription restarts, stopping auto-restart')
            logger.warn('Too many transcription restarts, stopping auto-restart', {
              restartCount: transcriptionRestartCountRef.current
            })
            transcriptionRestartCountRef.current = 0
            // Restart wake word recognition if transcription fails
            if (wakeModeRef.current && recognitionRef.current && !recognitionRunningRef.current) {
              try {
                recognitionRef.current.start()
              } catch (err) {
                console.warn('⚠️ Failed to restart wake word recognition', err)
              }
            }
            return
          }
          
          // Clear any existing restart timeout
          if (transcriptionRestartTimeoutRef.current) {
            clearTimeout(transcriptionRestartTimeoutRef.current)
          }
          
          // Add exponential backoff delay before restarting
          const delay = Math.min(1000 * Math.pow(2, transcriptionRestartCountRef.current), 5000)
          transcriptionRestartCountRef.current++
          
          console.log(`🟢 Scheduling transcription restart in ${delay}ms (attempt ${transcriptionRestartCountRef.current})`)
          transcriptionRestartTimeoutRef.current = window.setTimeout(() => {
            transcriptionRestartTimeoutRef.current = null
            // Double-check that we're still recording before restarting
            const mediaRecorder = mediaRecorderRef.current
            const transcriptionRecognition = transcriptionRecognitionRef.current
            const isStillRecording = speakingRef.current && 
                                    mediaRecorder && 
                                    mediaRecorder.state === 'recording' &&
                                    transcriptionRecognition &&
                                    !isTranscriptionStartingRef.current
            
            if (isStillRecording && transcriptionRecognition) {
              isTranscriptionStartingRef.current = true
              try {
                console.log('🟢 Auto-restarting transcription')
                transcriptionRecognition.start()
                logger.debug('Transcription restarted', { attempt: transcriptionRestartCountRef.current })
              } catch (err) {
                console.error('❌ Failed to restart transcription', err)
                logger.warn('Failed to restart transcription', err)
                isTranscriptionStartingRef.current = false
              }
            } else {
              console.log('🟡 Not restarting transcription - recording has stopped', {
                stillSpeaking: speakingRef.current,
                mediaRecorderState: mediaRecorder?.state
              })
              transcriptionRestartCountRef.current = 0
            }
          }, delay)
        } else {
          // Reset restart count if we're not restarting
          transcriptionRestartCountRef.current = 0
        }
      }

      try {
        console.log('🟢 Calling transcriptionRecognition.start()', {
          mediaRecorderState: mediaRecorderRef.current?.state,
          speakingRef: speakingRef.current,
          recognitionRunning: recognitionRunningRef.current,
          timestamp: new Date().toISOString()
        })
        isTranscriptionStartingRef.current = true
        transcriptionRecognition.start()
        console.log('✅ transcriptionRecognition.start() called - waiting for onstart event')
        logger.info('Transcription start() called successfully', {
          mediaRecorderState: mediaRecorderRef.current?.state
        })
        addLog('system', 'Starting speech recognition...')
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        console.error('❌ Failed to start transcription', {
          error: errorMsg,
          err,
          mediaRecorderState: mediaRecorderRef.current?.state,
          speakingRef: speakingRef.current
        })
        logger.error('Failed to start transcription', { error: errorMsg, err })
        addLog('system', `Failed to start transcription: ${errorMsg}`)
        setError(`Failed to start transcription: ${errorMsg}`)
        isTranscriptionStartingRef.current = false
      }
    } catch (err) {
      logger.error('Failed to start transcription', err)
      addLog('system', 'Failed to start transcription - check browser console')
    }
  }

  const stopTranscription = async () => {
    // Clear any pending restart
    if (transcriptionRestartTimeoutRef.current) {
      clearTimeout(transcriptionRestartTimeoutRef.current)
      transcriptionRestartTimeoutRef.current = null
    }
    transcriptionRestartCountRef.current = 0
    isTranscriptionStartingRef.current = false
    
    if (!transcriptionRecognitionRef.current) {
      return
    }
    
    try {
      transcriptionRecognitionRef.current.stop()
      // Wait a bit for final results to be processed
      await new Promise(resolve => setTimeout(resolve, 800))
    } catch {
      // ignore
    }
    transcriptionRecognitionRef.current = null
    
    // Don't restart wake word recognition here - let it restart naturally when needed
    // (e.g., when user manually triggers it or when recording completes)
  }

  const playTTS = (text: string) => {
    if (!text.trim() || !('speechSynthesis' in window)) {
      logger.warn('TTS not available or empty text', { hasTTS: 'speechSynthesis' in window, textLength: text.trim().length })
      return
    }

    // Stop any existing TTS
    stopTTS()

    try {
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = 'en-US'
      utterance.rate = 1.0
      utterance.pitch = 1.0
      utterance.volume = 1.0

      utterance.onstart = () => {
        setIsTTSPlaying(true)
        isTTSPlayingRef.current = true
        setStatusText('Playing response...')
        logger.info('TTS started', { textLength: text.length })
        
        // Stop any ongoing recording when TTS starts
        const mediaRecorder = mediaRecorderRef.current
        if (mediaRecorder && mediaRecorder.state === 'recording') {
          try {
            console.log('🟡 Stopping recording because TTS started')
            logger.info('Stopping recording because TTS started')
            mediaRecorder.stop()
            speakingRef.current = false
            setState('listening')
          } catch (err) {
            console.warn('⚠️ Failed to stop recording when TTS started', err)
            logger.warn('Failed to stop recording when TTS started', err)
          }
        }
        
        // Stop transcription if running
        if (transcriptionRecognitionRef.current) {
          try {
            console.log('🟡 Stopping transcription because TTS started')
            transcriptionRecognitionRef.current.stop()
          } catch {
            // ignore
          }
        }
      }

      utterance.onend = () => {
        setIsTTSPlaying(false)
        isTTSPlayingRef.current = false
        ttsUtteranceRef.current = null
        if (wakeModeRef.current) {
          setStatusText('Waiting for wake word: say "Hey AI" or "start"...')
        }
        logger.info('TTS ended')
      }

      utterance.onerror = (event) => {
        setIsTTSPlaying(false)
        isTTSPlayingRef.current = false
        ttsUtteranceRef.current = null
        logger.error('TTS error', event)
      }

      ttsUtteranceRef.current = utterance
      window.speechSynthesis.speak(utterance)
      logger.info('TTS speak called', { textLength: text.length })
    } catch (error) {
      logger.error('Failed to create TTS utterance', error)
      setIsTTSPlaying(false)
      isTTSPlayingRef.current = false
    }
  }

  const stopTTS = () => {
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel()
    }
    setIsTTSPlaying(false)
    isTTSPlayingRef.current = false
    ttsUtteranceRef.current = null
  }

  const playLastAudio = () => {
    if (!lastAudioBlobRef.current) {
      setError('No audio recording available to play')
      return
    }

    // Stop any currently playing audio
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause()
      audioPlayerRef.current = null
    }

    // Stop TTS if playing
    stopTTS()

    const audioUrl = URL.createObjectURL(lastAudioBlobRef.current)
    const audio = new Audio(audioUrl)
    audioPlayerRef.current = audio

    audio.onplay = () => {
      setIsAudioPlaying(true)
      isAudioPlayingRef.current = true
      setStatusText('Playing audio... (speak to interrupt)')
    }

    audio.onended = () => {
      URL.revokeObjectURL(audioUrl)
      audioPlayerRef.current = null
      setIsAudioPlaying(false)
      isAudioPlayingRef.current = false
      if (wakeModeRef.current) {
        setStatusText('Waiting for wake word: say "Hey AI" or "start"...')
      }
    }

    audio.onerror = () => {
      setError('Failed to play audio')
      URL.revokeObjectURL(audioUrl)
      audioPlayerRef.current = null
      setIsAudioPlaying(false)
      isAudioPlayingRef.current = false
    }

    audio.onpause = () => {
      setIsAudioPlaying(false)
      isAudioPlayingRef.current = false
    }

    audio.play().catch((err) => {
      logger.error('Failed to play audio', err)
      setError('Failed to play audio')
      URL.revokeObjectURL(audioUrl)
      audioPlayerRef.current = null
      setIsAudioPlaying(false)
    })
  }

  const stopAudio = () => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause()
      audioPlayerRef.current = null
      setIsAudioPlaying(false)
      isAudioPlayingRef.current = false
      setPlayingRecording(null)
    }
  }

  const playRecording = async (filename: string) => {
    try {
      // Stop any currently playing audio
      stopAudio()
      stopTTS()

      setPlayingRecording(filename)
      setStatusText(`Loading audio: ${filename}...`)

      const blob = await downloadAudioFile(filename)
      const audioUrl = URL.createObjectURL(blob)
      const audio = new Audio(audioUrl)
      audioPlayerRef.current = audio

      audio.onplay = () => {
        setIsAudioPlaying(true)
        isAudioPlayingRef.current = true
        setStatusText(`Playing: ${filename}... (speak to interrupt)`)
      }

      audio.onended = () => {
        URL.revokeObjectURL(audioUrl)
        audioPlayerRef.current = null
        setIsAudioPlaying(false)
        isAudioPlayingRef.current = false
        setPlayingRecording(null)
        if (wakeModeRef.current) {
          setStatusText('Waiting for wake word: say "Hey AI" or "start"...')
        }
      }

      audio.onerror = () => {
        setError('Failed to play audio')
        URL.revokeObjectURL(audioUrl)
        audioPlayerRef.current = null
        setIsAudioPlaying(false)
        isAudioPlayingRef.current = false
        setPlayingRecording(null)
      }

      audio.onpause = () => {
        setIsAudioPlaying(false)
        isAudioPlayingRef.current = false
        setPlayingRecording(null)
      }

      await audio.play()
    } catch (err) {
      logger.error('Failed to play recording', err)
      setError(`Failed to play audio: ${err instanceof Error ? err.message : 'Unknown error'}`)
      setPlayingRecording(null)
    }
  }

  const viewTranscriptionLog = async (sessionId: string) => {
    try {
      setLoadingLogContent(true)
      const content = await getTranscriptionLogContent(sessionId)
      setViewingLogContent(content)
    } catch (err) {
      logger.error('Failed to load transcription log', err)
      setError(`Failed to load log: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setLoadingLogContent(false)
    }
  }

  const uploadRecording = async (blob: Blob) => {
    // Use ref to get the latest sessionId value (important for closures)
    const currentSessionId = sessionIdRef.current || sessionId
    console.log('🔵 uploadRecording called', {
      blobSize: blob.size,
      saveTextFile: saveTextFileRef.current,
      sessionId: currentSessionId,
      sessionIdFromRef: sessionIdRef.current,
      sessionIdFromState: sessionId,
      timestamp: new Date().toISOString()
    })
    logger.info('uploadRecording called', {
      blobSize: blob.size,
      saveTextFile: saveTextFileRef.current,
      sessionId: currentSessionId,
      sessionIdFromRef: sessionIdRef.current,
      sessionIdFromState: sessionId
    })
    
    try {
      setState('uploading')
      
      // IMPORTANT: In text-only mode, MediaRecorder still works to capture audio for transcription
      // We just don't upload the audio file to the backend - only the transcription text is saved
      // If text file toggle is on, only send transcription (no audio upload)
      // Use ref to get the latest value (important for closures)
      if (saveTextFileRef.current) {
        console.log('🔵 Text-only mode: MediaRecorder worked for transcription, but skipping audio upload')
        // Use ref value which has the latest transcription (even if state hasn't updated)
        // Wait a bit more to ensure transcription is fully captured
        await new Promise(resolve => setTimeout(resolve, 200))
        const currentTranscription = transcriptionRef.current || transcription
        
        // Debug logging
        logger.info('Text-only mode: Preparing to send transcription', {
          sessionId: currentSessionId,
          sessionIdFromRef: sessionIdRef.current,
          sessionIdFromState: sessionId,
          transcriptionLength: currentTranscription.length,
          transcriptionPreview: currentTranscription.substring(0, 50),
          hasSessionId: !!currentSessionId,
          saveTextFileRef: saveTextFileRef.current
        })
        console.log('🔵 Text-only mode: Preparing to send transcription', {
          sessionId: currentSessionId,
          hasSessionId: !!currentSessionId
        })
        
        // Always send transcription if we have a sessionId, even if transcription is empty
        // This ensures session logs are created
        if (currentSessionId) {
          setStatusText('Sending transcription to backend...')
          try {
            // Send transcription even if empty to ensure session log is created
            const textToSend = currentTranscription.trim() || '(no transcription)'
            console.log('🟢 Sending transcription to backend', {
              sessionId: currentSessionId,
              textLength: textToSend.length,
              textPreview: textToSend.substring(0, 100),
              apiUrl: `${config.apiUrl}/transcription`
            })
            logger.info('Sending transcription to backend', { 
              sessionId: currentSessionId, 
              textLength: textToSend.length,
              textPreview: textToSend.substring(0, 100)
            })
            await sendTranscriptionText(textToSend, currentSessionId)
            console.log('✅ Transcription sent successfully')
            logger.info('Transcription text sent to backend successfully', { sessionId: currentSessionId, length: textToSend.length })
            setStatusText('Transcription saved to session log.')
            addLog('upload', 'Transcription saved to session log', `Session: ${currentSessionId}`)
            
            // Refresh transcription logs list
            try {
              const logsData = await getTranscriptionLogs()
              setTranscriptionLogs(logsData)
              logger.info('Transcription logs list refreshed', { count: logsData.length })
            } catch (err) {
              logger.warn('Failed to refresh transcription logs list', err)
            }
          } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err)
            logger.error('Failed to send transcription text', { error: errorMsg, sessionId: currentSessionId, err })
            setStatusText('Failed to save transcription.')
            setError(`Failed to save transcription: ${errorMsg}`)
            addLog('upload', 'Failed to save transcription', errorMsg)
            setState('error')
            return
          }
        } else {
          logger.error('No sessionId available for transcription', { 
            sessionId: currentSessionId,
            sessionIdFromRef: sessionIdRef.current,
            sessionIdFromState: sessionId
          })
          console.error('❌ No sessionId available', {
            sessionId: currentSessionId,
            sessionIdFromRef: sessionIdRef.current,
            sessionIdFromState: sessionId
          })
          setStatusText('No session ID available to save transcription.')
          setError('No session ID available')
          addLog('upload', 'No session ID available', 'Cannot save transcription without session ID')
        }
      } else {
        // Toggle is off: save audio recording
        setStatusText('Uploading recording to backend...')
        const data = await uploadFile(blob, 'recording.webm')
        setLastFilename(data.filename)
        setStatusText('Recording uploaded successfully.')
        
        // Refresh recordings list
        try {
          const recordingsData = await getRecordings()
          setRecordings(recordingsData)
        } catch (err) {
          logger.warn('Failed to refresh recordings list', err)
        }
      }
      
      if (wakeModeRef.current) {
        // Stay in wake mode and keep listening for the next trigger
        setState('listening')
        setStatusText('Say "Hey AI" or "start" again when ready.')
      } else {
        setState('done')
      }
    } catch (err: unknown) {
      logger.error('Upload failed', err)
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
  const heyAiLabel = wakeEverTriggered ? 'Wake word detected' : 'Waiting for "Hey AI" or "start"'

  const vadBadgeClass = {
    silence: 'bg-dark-800 border-dark-600 text-gray-300',
    noise: 'border-gold-600 text-gold-300',
    speech: 'border-gold-500 text-gold-200',
  }[vadClass]

  const vadBadgeStyle = {
    silence: {},
    noise: { backgroundColor: 'rgba(120, 53, 15, 0.2)', borderColor: 'rgba(217, 119, 6, 0.6)' },
    speech: { backgroundColor: 'rgba(120, 53, 15, 0.3)', borderColor: 'rgba(217, 119, 6, 0.8)' },
  }[vadClass] || {}

  return (
    <div className="min-h-screen h-full w-full bg-gradient-to-br from-dark-950 via-dark-900 to-dark-950 text-gray-100 flex flex-col">
      {/* Header - Always visible at top */}
      <header className="w-full border-b-2 sticky top-0 z-20" style={{ borderColor: 'rgba(217, 119, 6, 0.4)', backgroundColor: 'rgba(17, 24, 39, 0.95)', backdropFilter: 'blur(10px)' }}>
        <div className="max-w-7xl mx-auto px-6 py-5">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold" style={{ background: 'linear-gradient(to right, #fbbf24, #d97706)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>
                VAD-based WebRTC Recorder
              </h1>
              <p className="text-sm text-gray-400 mt-1">
                Voice-activated recording with wake word detection and real-time transcription
              </p>
            </div>
            {logs.length > 0 && (
              <button
                onClick={() => setShowLogs(!showLogs)}
                className="px-4 py-2 rounded-lg text-sm bg-dark-800 border-2 text-gold-300 hover:bg-dark-700 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-gold-500 focus:ring-offset-2 focus:ring-offset-dark-900 flex items-center gap-2 font-medium"
                style={{ borderColor: 'rgba(217, 119, 6, 0.5)' }}
                title={showLogs ? 'Hide event logs' : 'Show event logs'}
                aria-label={showLogs ? 'Hide event logs' : 'Show event logs'}
                aria-expanded={showLogs}
                type="button"
              >
                <span>{showLogs ? '▼' : '▶'}</span>
                <span>Event Logs</span>
                <span className="px-2 py-0.5 rounded-full bg-gold-900/30 text-gold-200 text-xs font-semibold">
                  {logs.length}
                </span>
          </button>
        )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 w-full max-w-7xl mx-auto px-6 pt-8 pb-4">
        {/* Transcription - Prominent Display Above All Content */}
        <div className="mb-6 rounded-xl p-6 border-2" style={{ backgroundColor: 'rgba(31, 41, 55, 0.8)', borderColor: 'rgba(217, 119, 6, 0.5)', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.3)' }}>
          <div className="flex items-center gap-3 mb-4">
            <span className="text-2xl">📝</span>
            <div>
              <h2 className="text-lg font-bold text-gold-300">Live Transcription</h2>
              <p className="text-xs text-gray-400">Real-time speech-to-text conversion</p>
            </div>
          </div>
          <div className="p-5 rounded-lg border-2" style={{ backgroundColor: 'rgba(17, 24, 39, 0.7)', borderColor: 'rgba(217, 119, 6, 0.3)', minHeight: '100px', maxHeight: '300px', overflowY: 'auto' }}>
            {completeTranscription || transcription ? (
              <div>
                {completeTranscription && (
                  <p className="text-gray-300 leading-relaxed text-sm font-normal whitespace-pre-wrap mb-3">{completeTranscription}</p>
                )}
                {transcription && (
                  <p className={`text-gold-200 leading-relaxed text-base font-medium whitespace-pre-wrap ${completeTranscription ? 'border-t-2 pt-3' : ''}`} style={{ borderColor: 'rgba(217, 119, 6, 0.3)' }}>
                    {transcription}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-gray-500 italic text-sm">Waiting for speech... Transcription will appear here when you start speaking.</p>
            )}
          </div>
          {(isTTSPlaying || isAudioPlaying) && (
            <div className="mt-3 flex items-center gap-2 text-sm text-gold-400">
              <span className="animate-pulse">🔊</span>
              <span>
                {isTTSPlaying && 'Playing response... (speak to interrupt)'}
                {isAudioPlaying && 'Playing audio... (speak to interrupt)'}
              </span>
            </div>
          )}
        </div>

        {/* Stats Bar */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <div className="rounded-lg p-4 border-2" style={{ backgroundColor: 'rgba(31, 41, 55, 0.6)', borderColor: 'rgba(217, 119, 6, 0.3)' }}>
            <div className="text-xs uppercase tracking-wider text-gray-400 mb-1">Recordings</div>
            <div className="text-2xl font-bold text-gold-400">{recordings.length}</div>
            <div className="text-xs text-gray-500 mt-1">Audio files</div>
          </div>
          <div className="rounded-lg p-4 border-2" style={{ backgroundColor: 'rgba(31, 41, 55, 0.6)', borderColor: 'rgba(217, 119, 6, 0.3)' }}>
            <div className="text-xs uppercase tracking-wider text-gray-400 mb-1">Status</div>
            <div className="text-2xl font-bold text-gold-400 capitalize">{state}</div>
            <div className="text-xs text-gray-500 mt-1">{wakeMode ? 'Wake mode active' : 'Standby'}</div>
          </div>
          <div className="rounded-lg p-4 border-2" style={{ backgroundColor: 'rgba(31, 41, 55, 0.6)', borderColor: 'rgba(217, 119, 6, 0.3)' }}>
            <div className="text-xs uppercase tracking-wider text-gray-400 mb-1">Energy Level</div>
            <div className="text-2xl font-bold text-gold-400">{Math.round(energyLevel * 100)}%</div>
            <div className="text-xs text-gray-500 mt-1">Current audio</div>
          </div>
          <div className="rounded-lg p-4 border-2" style={{ backgroundColor: 'rgba(31, 41, 55, 0.6)', borderColor: 'rgba(217, 119, 6, 0.3)' }}>
            <div className="text-xs uppercase tracking-wider text-gray-400 mb-1">Events</div>
            <div className="text-2xl font-bold text-gold-400">{logs.length}</div>
            <div className="text-xs text-gray-500 mt-1">Logged events</div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column - Controls */}
          <div className="lg:col-span-1 space-y-6">
            {/* Start Button */}
        {!wakeMode && micPermission !== 'granted' && (
              <div className="rounded-xl p-6 border-2" style={{ backgroundColor: 'rgba(31, 41, 55, 0.7)', borderColor: 'rgba(217, 119, 6, 0.4)', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.3)' }}>
                <div className="text-sm text-gray-400 mb-4">
                  <p className="font-medium text-gold-300 mb-2">Get Started</p>
                  <p className="text-xs">Click the button below to start listening for wake words. Say "Hey AI" or "start" to begin recording.</p>
                </div>
                <button
                  onClick={startWakeWordMode}
                  className="w-full bg-gradient-to-r from-gold-600 to-gold-700 hover:from-gold-500 hover:to-gold-600 text-white font-semibold py-3 px-6 rounded-lg transition-all duration-200 shadow-lg focus:outline-none focus:ring-2 focus:ring-gold-500 focus:ring-offset-2 focus:ring-offset-dark-900"
                  style={{ boxShadow: '0 10px 15px -3px rgba(120, 53, 15, 0.5)' }}
                  aria-label="Start listening for wake word"
                  type="button"
                >
                  🎤 Start listening
          </button>
              </div>
            )}

            {/* Status Card */}
            <div 
              className="rounded-xl p-6 border-2" 
              style={{ backgroundColor: 'rgba(31, 41, 55, 0.7)', borderColor: 'rgba(217, 119, 6, 0.4)', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.3)' }}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gold-300 uppercase tracking-wider">System Status</h3>
                <div className={`w-3 h-3 rounded-full ${state === 'recording' ? 'bg-red-500 animate-pulse' : state === 'listening' ? 'bg-green-500' : 'bg-gray-500'}`}></div>
              </div>
              <p className="text-gold-200 font-medium text-sm leading-relaxed">{statusText}</p>
              {state === 'uploading' && (
                <div className="mt-4 flex items-center gap-2 p-3 rounded-lg" style={{ backgroundColor: 'rgba(17, 24, 39, 0.5)' }}>
                  <div className="animate-spin rounded-full h-5 w-5 border-2 border-gold-500 border-t-transparent"></div>
                  <span className="text-xs text-gray-300 font-medium">Uploading to server...</span>
                </div>
              )}
            </div>

            {/* Error Display */}
            {error && (
              <div className="rounded-xl p-4 border-2" style={{ backgroundColor: 'rgba(127, 29, 29, 0.3)', borderColor: 'rgba(239, 68, 68, 0.6)', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.3)' }}>
                <div className="flex items-start gap-3">
                  <span className="text-red-400 text-xl">⚠️</span>
                  <div className="flex-1">
                    <p className="text-red-300 font-semibold text-sm mb-1">Error</p>
                    <p className="text-red-200 text-sm">{error}</p>
          </div>
          </div>
          </div>
            )}

            {/* Save Text File Toggle */}
            <div className="rounded-xl p-6 border-2" style={{ backgroundColor: 'rgba(31, 41, 55, 0.7)', borderColor: saveTextFile ? 'rgba(217, 119, 6, 0.6)' : 'rgba(217, 119, 6, 0.4)', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.3)' }}>
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="text-sm font-semibold text-gold-300 uppercase tracking-wider">Text-Only Mode</h3>
                    {saveTextFile && (
                      <span className="px-2 py-0.5 text-xs font-semibold rounded" style={{ backgroundColor: 'rgba(217, 119, 6, 0.2)', color: '#fbbf24' }}>
                        ON
                      </span>
                    )}
                    {!saveTextFile && (
                      <span className="px-2 py-0.5 text-xs font-semibold rounded bg-gray-700 text-gray-400">
                        OFF
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-400">
                    {saveTextFile 
                      ? 'Only transcription will be saved (no audio recording)'
                      : 'Audio recordings will be saved normally'}
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer ml-4" style={{ minWidth: '3.5rem' }}>
                  <input
                    type="checkbox"
                    checked={saveTextFile}
                    onChange={(e) => {
                      const newValue = e.target.checked
                      setSaveTextFile(newValue)
                      saveTextFileRef.current = newValue
                    }}
                    className="sr-only"
                  />
                  <div 
                    className="w-14 h-7 rounded-full transition-all duration-200 relative"
                    style={{
                      backgroundColor: saveTextFile ? '#d97706' : '#374151',
                      boxShadow: saveTextFile ? '0 0 0 2px rgba(217, 119, 6, 0.3)' : 'inset 0 2px 4px rgba(0, 0, 0, 0.2)'
                    }}
                  >
                    <div
                      className="absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full transition-all duration-200 shadow-md"
                      style={{
                        transform: saveTextFile ? 'translateX(1.75rem)' : 'translateX(0)',
                      }}
                    ></div>
                  </div>
                </label>
              </div>
            </div>

            {/* Last Filename and Play Button */}
        {lastFilename && (
              <div className="rounded-xl p-4 border-2" style={{ backgroundColor: 'rgba(31, 41, 55, 0.7)', borderColor: 'rgba(217, 119, 6, 0.4)', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.3)' }}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-gold-400">💾</span>
                    <p className="text-xs text-gray-400 font-medium">Last Saved Recording</p>
                  </div>
                  {lastAudioBlob && (
                    <button
                      onClick={playLastAudio}
                      className="px-3 py-1.5 rounded-lg text-xs bg-gold-600 hover:bg-gold-500 text-white font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-gold-500 focus:ring-offset-2 focus:ring-offset-dark-900 flex items-center gap-1.5"
                      title="Play last audio recording"
                      type="button"
                    >
                      <span>▶</span>
                      <span>Play Audio</span>
                    </button>
                  )}
                </div>
                <code className="text-gold-300 text-sm font-mono break-all bg-dark-900 px-3 py-2 rounded block">{lastFilename}</code>
          </div>
        )}

            {/* Quick Info Card */}
            <div className="rounded-xl p-6 border-2" style={{ backgroundColor: 'rgba(31, 41, 55, 0.7)', borderColor: 'rgba(217, 119, 6, 0.4)', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.3)' }}>
              <h3 className="text-sm font-semibold text-gold-300 uppercase tracking-wider mb-4">Quick Info</h3>
              <div className="space-y-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-gray-400">Microphone:</span>
                  <span className={`font-medium ${micPermission === 'granted' ? 'text-green-400' : micPermission === 'denied' ? 'text-red-400' : 'text-yellow-400'}`}>
                    {micPermission === 'granted' ? '✓ Granted' : micPermission === 'denied' ? '✗ Denied' : '? Unknown'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-400">Wake Word:</span>
                  <span className={`font-medium ${wakeEverTriggered ? 'text-green-400' : 'text-gray-500'}`}>
                    {wakeEverTriggered ? '✓ Detected' : 'Waiting'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-400">Transcription:</span>
                  <span className={`font-medium ${transcription ? 'text-green-400' : 'text-gray-500'}`}>
                    {transcription ? '✓ Active' : 'Inactive'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column - Monitor */}
          <div className="lg:col-span-2 space-y-6">
            {/* VAD Monitor Card */}
            <div className="rounded-xl p-6 border-2" style={{ backgroundColor: 'rgba(31, 41, 55, 0.7)', borderColor: 'rgba(217, 119, 6, 0.4)', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.3)' }}>
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-xl font-bold text-gold-300 mb-1">Live VAD Monitor</h2>
                  <p className="text-xs text-gray-400">Real-time voice activity detection and analysis</p>
                </div>
                <span className={`px-4 py-2 rounded-full text-sm font-bold border-2 ${vadBadgeClass}`} style={vadBadgeStyle}>
                  {vadLabel}
                </span>
              </div>

              {/* Status Rows */}
              <div className="grid grid-cols-2 gap-4 mb-6">
                <div className="p-4 rounded-lg border-2" style={{ backgroundColor: 'rgba(17, 24, 39, 0.5)', borderColor: 'rgba(217, 119, 6, 0.3)' }}>
                  <div className="text-xs uppercase tracking-wider text-gray-400 mb-2">Wake Status</div>
                  <div className="px-3 py-2 rounded-lg bg-dark-800 border-2 text-gold-300 text-sm font-semibold text-center" style={{ borderColor: 'rgba(217, 119, 6, 0.4)' }}>
                    {wakeLabel}
                  </div>
                </div>
                <div className="p-4 rounded-lg border-2" style={{ backgroundColor: 'rgba(17, 24, 39, 0.5)', borderColor: 'rgba(217, 119, 6, 0.3)' }}>
                  <div className="text-xs uppercase tracking-wider text-gray-400 mb-2">Trigger Word</div>
                  <div className="px-3 py-2 rounded-lg bg-dark-800 border-2 text-gold-300 text-sm font-semibold text-center" style={{ borderColor: 'rgba(217, 119, 6, 0.4)' }}>
                    {heyAiLabel}
                  </div>
                </div>
              </div>

              {/* Energy Meter */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-semibold text-gold-300">Audio Energy Level</span>
                  <span className="text-lg font-bold text-gold-400">{Math.round(energyLevel * 100)}%</span>
                </div>
                <div className="h-4 bg-dark-900 rounded-full overflow-hidden border-2" style={{ borderColor: 'rgba(217, 119, 6, 0.4)' }}>
                  <div
                    className={`h-full transition-all duration-150 ${
                      vadClass === 'silence'
                        ? 'bg-gray-600'
                        : vadClass === 'noise'
                        ? 'bg-gold-600'
                        : 'bg-gold-400'
                    }`}
              style={{ width: `${Math.round(energyLevel * 100)}%` }}
            />
          </div>
                <div className="flex justify-between text-xs text-gray-500 mt-2 px-1">
                  <span className="font-medium">Silence</span>
                  <span className="font-medium">Noise</span>
                  <span className="font-medium">Speech</span>
                </div>
          </div>
        </div>

            {/* Event Log Section - Shows when Event Logs tab is open */}
            {showLogs && (
              <div className="space-y-6">
                {/* System Event Log */}
                {logs.length > 0 && (
                  <div className="rounded-xl p-6 border-2" style={{ backgroundColor: 'rgba(31, 41, 55, 0.7)', borderColor: 'rgba(217, 119, 6, 0.4)', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.3)' }}>
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <h2 className="text-xl font-bold text-gold-300 mb-1">System Event Log</h2>
                        <p className="text-xs text-gray-400">System events and activity history</p>
                      </div>
                      <span className="px-3 py-2 rounded-lg bg-dark-800 border-2 text-gold-300 text-sm font-semibold" style={{ borderColor: 'rgba(217, 119, 6, 0.4)' }}>
                        {logs.length} entries
                      </span>
                    </div>
                    <div className="rounded-lg border-2 p-4 max-h-96 overflow-y-auto" style={{ backgroundColor: 'rgba(17, 24, 39, 0.5)', borderColor: 'rgba(217, 119, 6, 0.3)' }}>
                      <ul className="space-y-3">
                        {logs.map((log) => {
                          const logColor = {
                            system: 'text-blue-300',
                            wake: 'text-gold-300',
                            vad: 'text-green-300',
                            upload: 'text-cyan-300',
                          }[log.source]
                          const logIcon = {
                            system: '🔧',
                            wake: '👂',
                            vad: '🎤',
                            upload: '📤',
                          }[log.source]
                          return (
                            <li key={log.id} className="text-xs border-b-2 pb-3 last:border-0 last:pb-0" style={{ borderColor: 'rgba(55, 65, 81, 0.6)' }}>
                              <div className="flex items-start gap-3">
                                <span className="text-gray-500 min-w-[70px] font-mono text-[10px] pt-0.5" style={{ fontSize: '10px' }}>{log.timestamp}</span>
                                <span className="text-base">{logIcon}</span>
                                <div className="flex-1">
                                  <span className={`${logColor} font-medium`}>{log.message}</span>
                                  {log.meta && (
                                    <span className="text-gray-500 italic block mt-1 truncate text-[11px]">{log.meta}</span>
                                  )}
                                </div>
                              </div>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  </div>
                )}

                {/* Audio Recordings List */}
                <div className="rounded-xl p-6 border-2" style={{ backgroundColor: 'rgba(31, 41, 55, 0.7)', borderColor: 'rgba(217, 119, 6, 0.4)', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.3)' }}>
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h2 className="text-xl font-bold text-gold-300 mb-1">Audio Recordings</h2>
                      <p className="text-xs text-gray-400">List of all recorded audio files</p>
          </div>
                    <span className="px-3 py-2 rounded-lg bg-dark-800 border-2 text-gold-300 text-sm font-semibold" style={{ borderColor: 'rgba(217, 119, 6, 0.4)' }}>
                      {recordings.length} files
                    </span>
                  </div>
                  <div className="rounded-lg border-2 p-4 max-h-96 overflow-y-auto" style={{ backgroundColor: 'rgba(17, 24, 39, 0.5)', borderColor: 'rgba(217, 119, 6, 0.3)' }}>
                    {loadingRecordings ? (
                      <div className="flex items-center justify-center py-8">
                        <div className="animate-spin rounded-full h-8 w-8 border-2 border-gold-500 border-t-transparent"></div>
                        <span className="ml-3 text-gray-400">Loading recordings...</span>
                      </div>
                    ) : recordings.length === 0 ? (
                      <p className="text-gray-500 italic text-sm text-center py-8">No audio recordings found</p>
                    ) : (
                      <ul className="space-y-3">
                        {recordings.map((recording, index) => {
                          const sizeMB = (recording.size / (1024 * 1024)).toFixed(2)
                          const modifiedDate = new Date(recording.modified).toLocaleString()
                          const isPlaying = playingRecording === recording.filename
                          return (
                            <li key={index} className="text-xs border-b-2 pb-3 last:border-0 last:pb-0" style={{ borderColor: 'rgba(55, 65, 81, 0.6)' }}>
                              <div className="flex items-start gap-3">
                                <span className="text-cyan-400 text-base">🎵</span>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-1">
                                    <code className="text-cyan-300 font-mono text-xs break-all">{recording.filename}</code>
                                  </div>
                                  <div className="flex items-center gap-4 text-gray-400 text-[11px] mb-2">
                                    <span>{sizeMB} MB</span>
                                    <span>•</span>
                                    <span>{modifiedDate}</span>
                                  </div>
                                  <button
                                    onClick={() => playRecording(recording.filename)}
                                    disabled={isPlaying}
                                    className="px-2 py-1 rounded text-[10px] bg-cyan-600 hover:bg-cyan-500 text-white font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                                    title="Play audio recording"
                                    type="button"
                                  >
                                    {isPlaying ? (
                                      <>
                                        <span className="animate-pulse">⏸</span>
                                        <span>Playing...</span>
                                      </>
                                    ) : (
                                      <>
                                        <span>▶</span>
                                        <span>Play</span>
                                      </>
                                    )}
                                  </button>
                                </div>
                              </div>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                </div>

                {/* Transcription Logs List */}
                <div className="rounded-xl p-6 border-2" style={{ backgroundColor: 'rgba(31, 41, 55, 0.7)', borderColor: 'rgba(217, 119, 6, 0.4)', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.3)' }}>
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h2 className="text-xl font-bold text-gold-300 mb-1">Transcription Logs</h2>
                      <p className="text-xs text-gray-400">Session-based transcription text files</p>
                    </div>
                    <span className="px-3 py-2 rounded-lg bg-dark-800 border-2 text-gold-300 text-sm font-semibold" style={{ borderColor: 'rgba(217, 119, 6, 0.4)' }}>
                      {transcriptionLogs.length} sessions
                    </span>
                  </div>
                  <div className="rounded-lg border-2 p-4 max-h-96 overflow-y-auto" style={{ backgroundColor: 'rgba(17, 24, 39, 0.5)', borderColor: 'rgba(217, 119, 6, 0.3)' }}>
                    {loadingLogs ? (
                      <div className="flex items-center justify-center py-8">
                        <div className="animate-spin rounded-full h-8 w-8 border-2 border-gold-500 border-t-transparent"></div>
                        <span className="ml-3 text-gray-400">Loading logs...</span>
                      </div>
                    ) : transcriptionLogs.length === 0 ? (
                      <p className="text-gray-500 italic text-sm text-center py-8">No transcription logs found</p>
                    ) : (
                      <ul className="space-y-3">
                        {transcriptionLogs.map((log, index) => {
                          const sizeKB = (log.size / 1024).toFixed(2)
                          const modifiedDate = new Date(log.modified).toLocaleString()
                          const isViewing = viewingLogContent?.session_id === log.session_id
                          return (
                            <li key={index} className="text-xs border-b-2 pb-3 last:border-0 last:pb-0" style={{ borderColor: 'rgba(55, 65, 81, 0.6)' }}>
                              <div className="flex items-start gap-3">
                                <span className="text-green-400 text-base">📝</span>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-1">
                                    <code className="text-green-300 font-mono text-xs break-all">{log.session_id}</code>
                                    <span className="px-2 py-0.5 rounded bg-dark-800 text-gray-400 text-[10px]">
                                      {log.entry_count} entries
                                    </span>
                                  </div>
                                  <div className="text-gray-400 text-[11px] mb-2 truncate">{log.first_entry}</div>
                                  <div className="flex items-center gap-4 text-gray-500 text-[11px] mb-2">
                                    <span>{sizeKB} KB</span>
                                    <span>•</span>
                                    <span>{modifiedDate}</span>
                                  </div>
                                  <button
                                    onClick={() => viewTranscriptionLog(log.session_id)}
                                    disabled={loadingLogContent}
                                    className="px-2 py-1 rounded text-[10px] bg-green-600 hover:bg-green-500 text-white font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                                    title="View transcription log content"
                                    type="button"
                                  >
                                    {loadingLogContent && isViewing ? (
                                      <>
                                        <span className="animate-spin">⟳</span>
                                        <span>Loading...</span>
                                      </>
                                    ) : (
                                      <>
                                        <span>📄</span>
                                        <span>View</span>
                                      </>
                                    )}
                                  </button>
                                </div>
                              </div>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Transcription Log Viewer Modal */}
            {viewingLogContent && (
              <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0, 0, 0, 0.8)' }}>
                <div className="rounded-xl p-6 border-2 max-w-4xl w-full max-h-[90vh] flex flex-col" style={{ backgroundColor: 'rgba(31, 41, 55, 0.95)', borderColor: 'rgba(217, 119, 6, 0.6)', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)' }}>
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h2 className="text-xl font-bold text-gold-300 mb-1">Transcription Log</h2>
                      <p className="text-xs text-gray-400">{viewingLogContent.session_id}</p>
                    </div>
                    <button
                      onClick={() => setViewingLogContent(null)}
                      className="px-4 py-2 rounded-lg text-sm bg-dark-800 border-2 text-gold-300 hover:bg-dark-700 transition-all"
                      style={{ borderColor: 'rgba(217, 119, 6, 0.5)' }}
                      type="button"
                    >
                      ✕ Close
                    </button>
                  </div>
                  <div className="rounded-lg border-2 p-4 flex-1 overflow-y-auto" style={{ backgroundColor: 'rgba(17, 24, 39, 0.7)', borderColor: 'rgba(217, 119, 6, 0.3)', minHeight: '300px' }}>
                    <pre className="text-sm text-gray-200 whitespace-pre-wrap font-mono leading-relaxed">
                      {viewingLogContent.content}
                    </pre>
                  </div>
                  <div className="mt-4 flex items-center justify-between text-xs text-gray-400">
                    <span>Size: {(viewingLogContent.size / 1024).toFixed(2)} KB</span>
                    <span>Modified: {new Date(viewingLogContent.modified).toLocaleString()}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Segments */}
        {segments.length > 0 && (
              <div className="rounded-xl p-6 border-2" style={{ backgroundColor: 'rgba(31, 41, 55, 0.7)', borderColor: 'rgba(217, 119, 6, 0.4)', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.3)' }}>
                <div className="flex items-center gap-2 mb-4">
                  <span className="text-gold-400">⏱️</span>
                  <h3 className="text-lg font-bold text-gold-300">
                    Speech Timing Analysis
                  </h3>
                </div>
                <div className="space-y-3">
              {segments.map((s, idx) => (
                    <div key={idx} className="p-4 rounded-lg border-2" style={{ backgroundColor: 'rgba(17, 24, 39, 0.5)', borderColor: 'rgba(217, 119, 6, 0.3)' }}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-gold-400 font-semibold">Segment {idx + 1}</span>
                        <span className="text-xs text-gray-400">{s.duration.toFixed(2)}s</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs text-gray-300">
                        <div>
                          <span className="text-gray-500">Start: </span>
                          <span className="font-mono">{s.start.toFixed(2)}s</span>
                        </div>
                        <div>
                          <span className="text-gray-500">End: </span>
                          <span className="font-mono">{s.end.toFixed(2)}s</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
          </div>
        )}
      </div>
        </div>
      </main>

      {/* Footer - Always visible at bottom */}
      <footer className="w-full border-t-2 mt-auto sticky bottom-0 z-10" style={{ borderColor: 'rgba(217, 119, 6, 0.4)', backgroundColor: 'rgba(17, 24, 39, 0.95)', backdropFilter: 'blur(10px)' }}>
        <div className="max-w-7xl mx-auto px-6 py-5">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <p className="text-xs text-gray-400 text-center md:text-left">
              <span className="text-gold-400 font-semibold">VAD WebRTC Recorder</span> · Frontend: React + Vite · Backend: FastAPI
            </p>
            <div className="flex items-center gap-4 text-xs text-gray-500">
              {wakeMode && <span className="px-2 py-1 rounded bg-gold-900/20 text-gold-300">Wake Mode Active</span>}
              <span>v1.0.0</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}

export default App
