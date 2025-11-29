import { useEffect, useRef, useState } from 'react'
import { logger } from './utils/logger'
import { AudioWebSocket } from './utils/api'
import { config } from './config'

type RecorderState = 'idle' | 'listening' | 'recording' | 'done' | 'error'
type VadClass = 'silence' | 'noise' | 'speech'

type SpeechSegment = {
  start: number
  end: number
  duration: number
}

type LogSource = 'system' | 'wake' | 'vad'
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
  const [error, setError] = useState<string | null>(null)
  const [segments, setSegments] = useState<SpeechSegment[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  // VAD sensitivity tuning
  const [vadSensitivity, setVadSensitivity] = useState<number>(0.5) // 0.0 to 1.0
  const vadSensitivityRef = useRef<number>(0.5)
  const [showLogs, setShowLogs] = useState<boolean>(true)
  const [sessionId, setSessionId] = useState<string>('')
  const sessionIdRef = useRef<string>('')
  // Chatbot state
  type ChatMessage = {
    id: string
    type: 'user' | 'assistant'
    content: string
    timestamp: Date
    backend?: string
    error?: string | undefined
  }
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [isProcessing, setIsProcessing] = useState<boolean>(false)
  const [isTTSPlaying, setIsTTSPlaying] = useState<boolean>(false)
  const currentQuestionRef = useRef<string>('')
  const pendingUserMessageRef = useRef<string | null>(null)

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
  const gainNodeRef = useRef<GainNode | null>(null)
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
  // SpeechRecognition state tracking (for wake word only)
  const recognitionRunningRef = useRef(false)
  const recognitionRetryTimeoutRef = useRef<number | null>(null)
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
  const currentAudioChunksRef = useRef<Blob[]>([])
  const audioWebSocketRef = useRef<AudioWebSocket | null>(null)
  const ttsUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null)
  const isTTSPlayingRef = useRef<boolean>(false)
  const chatMessagesEndRef = useRef<HTMLDivElement | null>(null)
  const chatContainerRef = useRef<HTMLDivElement | null>(null)

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
    currentAudioChunksRef.current = []
  }

  const cleanup = () => {
    if (rafIdRef.current != null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }

    analyserRef.current?.disconnect()
    analyserRef.current = null

    gainNodeRef.current?.disconnect()
    gainNodeRef.current = null

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
    // WebSocket cleanup - disable auto-reconnect and disconnect
    if (audioWebSocketRef.current) {
      audioWebSocketRef.current.disableAutoReconnect()
      audioWebSocketRef.current.disconnect()
      audioWebSocketRef.current = null
    }
  }

  // Sync sessionIdRef with sessionId state
  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  // Sync vadSensitivityRef with vadSensitivity state
  useEffect(() => {
    vadSensitivityRef.current = vadSensitivity
  }, [vadSensitivity])

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

  // Auto-scroll chat to bottom when new messages arrive (ChatGPT style)
  useEffect(() => {
    if (chatMessagesEndRef.current) {
      chatMessagesEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [chatMessages, isProcessing])

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

  // No longer fetching recordings or logs - removed saving functionality

  // Start wake-word mode (one-time permission + continuous standby)
  const startWakeWordMode = async () => {
    try {
      setError(null)
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
      
      // Connect source to analyser for VAD only (no speaker feedback)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 2048
      analyserRef.current = analyser
      source.connect(analyser)
      
      // Do NOT connect to destination - we don't want to hear our own voice

      const mediaRecorder = new MediaRecorder(stream)
      mediaRecorderRef.current = mediaRecorder

      chunksRef.current = []
      
      // Initialize WebSocket for chatbot responses ONCE (not in the VAD loop)
      if (!audioWebSocketRef.current && sessionIdRef.current) {
        logger.info('Initializing WebSocket for chatbot', { sessionId: sessionIdRef.current })
        audioWebSocketRef.current = new AudioWebSocket(
          sessionIdRef.current,
          () => {}, // No transcription callback needed
          (response) => {
            // Handle chatbot response - ChatGPT style
            logger.info('Chatbot response callback triggered', { 
              hasResponse: !!response.response,
              hasError: !!response.error,
              hasTranscription: !!response.transcription,
              currentQuestionId: currentQuestionRef.current
            })
            
            setIsProcessing(false)
            
            // Update user message with actual transcription (ChatGPT shows user message immediately)
            // This ensures the transcription is always visible in chat history
            if (response.transcription) {
              if (currentQuestionRef.current) {
                logger.info('Updating user message with transcription', {
                  questionId: currentQuestionRef.current,
                  transcription: response.transcription.substring(0, 50)
                })
                setChatMessages((prev) => {
                  const updated = prev.map(msg => 
                    msg.id === currentQuestionRef.current && msg.type === 'user'
                      ? { ...msg, content: response.transcription! }
                      : msg
                  )
                  // Log if message was found and updated
                  const found = updated.find(msg => msg.id === currentQuestionRef.current)
                  if (found && found.content === response.transcription) {
                    logger.info('User message successfully updated with transcription')
                  } else {
                    logger.warn('User message not found or not updated, adding new message', {
                      questionId: currentQuestionRef.current,
                      messagesInState: prev.map(m => ({ id: m.id, type: m.type }))
                    })
                    // If message not found, add it as a new user message
                    if (response.transcription) {
                      return [
                        ...updated,
                        {
                          id: currentQuestionRef.current,
                          type: 'user' as const,
                          content: response.transcription,
                          timestamp: new Date()
                        }
                      ]
                    }
                  }
                  return updated
                })
                pendingUserMessageRef.current = null
              } else {
                // No current question ID, but we have transcription - add it as a new message
                const transcription = response.transcription
                if (transcription) {
                  logger.info('Adding transcription as new user message (no current question ID)', {
                    transcription: transcription.substring(0, 50)
                  })
                  setChatMessages((prev) => [
                    ...prev,
                    {
                      id: `user-${Date.now()}`,
                      type: 'user',
                      content: transcription,
                      timestamp: new Date()
                    }
                  ])
                }
              }
            } else if (!response.transcription && currentQuestionRef.current) {
              logger.warn('No transcription received in chatbot response', {
                questionId: currentQuestionRef.current,
                hasResponse: !!response.response,
                hasError: !!response.error
              })
              // Keep the placeholder but mark it as transcribed (even without text)
              setChatMessages((prev) => prev.map(msg => 
                msg.id === currentQuestionRef.current && msg.type === 'user' && msg.content === '🎤 [Transcribing...]'
                  ? { ...msg, content: '🎤 [Audio recorded - transcription unavailable]' }
                  : msg
              ))
            }
            
            if (response.error) {
              logger.warn('Chatbot error', response.error)
              // Add error message as assistant message
              setChatMessages((prev) => [
                ...prev,
                {
                  id: `error-${Date.now()}`,
                  type: 'assistant',
                  content: `Error: ${response.error}`,
                  timestamp: new Date(),
                  error: response.error || undefined
                }
              ])
            } else if (response.response) {
              logger.info('Chatbot response received', { 
                response: response.response.substring(0, 50),
                backend: response.backend_used
              })
              
              // Add assistant response (ChatGPT style - appears after user message)
              setChatMessages((prev) => [
                ...prev,
                {
                  id: `assistant-${Date.now()}`,
                  type: 'assistant',
                  content: response.response!,
                  timestamp: new Date(),
                  backend: response.backend_used
                }
              ])
              
              addLog('system', 'Chatbot response received', response.response.substring(0, 50))
              
              // Play TTS response
              playTTS(response.response)
            } else {
              logger.warn('Chatbot response has no response or error')
            }
          },
          (error: Error) => {
            logger.error('WebSocket error', error)
            setIsProcessing(false)
            // Remove pending user message if WebSocket fails
            if (currentQuestionRef.current) {
              setChatMessages((prev) => prev.filter(msg => msg.id !== currentQuestionRef.current))
            }
            pendingUserMessageRef.current = null
            setError(`WebSocket error: ${error.message}`)
          }
        )
        
        // Check backend health before connecting WebSocket
        const checkBackendHealth = async () => {
          try {
            const healthUrl = `${config.apiUrl}/health`
            logger.info('Checking backend health', { url: healthUrl })
            const response = await fetch(healthUrl, { 
              method: 'GET',
              signal: AbortSignal.timeout(5000) // 5 second timeout
            })
            if (response.ok) {
              const health = await response.json()
              logger.info('Backend health check passed', health)
              return true
            } else {
              logger.warn('Backend health check failed', { status: response.status })
              return false
            }
          } catch (err) {
            logger.error('Backend health check error', err)
            return false
          }
        }
        
        // Connect WebSocket after health check
        checkBackendHealth().then((isHealthy) => {
          if (!isHealthy) {
            setIsProcessing(false)
            if (currentQuestionRef.current) {
              setChatMessages((prev) => prev.filter(msg => msg.id !== currentQuestionRef.current))
            }
            pendingUserMessageRef.current = null
            setError(`Backend server is not accessible at ${config.apiUrl}. Please ensure the backend is running.`)
            return
          }
          
          // Backend is healthy, enable auto-reconnect and try to connect WebSocket
          if (audioWebSocketRef.current) {
            audioWebSocketRef.current.enableAutoReconnect()
            audioWebSocketRef.current.connect().catch((err) => {
              logger.error('Failed to connect WebSocket (will auto-retry)', err)
              // Don't set error immediately - let auto-reconnect handle it
              // Only show error if max attempts reached (handled in onError callback)
            })
          }
        })
      }
      
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          // CRITICAL: Don't send audio chunks while TTS is playing (prevents feedback loop)
          if (isTTSPlayingRef.current) {
            logger.debug('Skipping audio chunk - TTS is playing')
            return
          }
          
          chunksRef.current.push(event.data)
          // Send audio chunk to WebSocket for chatbot processing
          if (audioWebSocketRef.current && audioWebSocketRef.current.isConnected()) {
            audioWebSocketRef.current.sendAudioChunk(event.data)
          } else {
            logger.warn('WebSocket not connected, cannot send audio chunk')
          }
        }
      }
      mediaRecorder.onstop = async () => {
        const currentSessionId = sessionIdRef.current || sessionId
        logger.info('MediaRecorder stopped', { 
          chunksCount: chunksRef.current.length,
          sessionId: currentSessionId
        })
        
        // Clear chunks - no longer saving audio
        chunksRef.current = []
        
        
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

      // Thresholds - adjusted by VAD sensitivity (0.0 = most sensitive, 1.0 = least sensitive)
      const BASE_SILENCE_RMS = 0.005
      const BASE_SPEECH_RMS = 0.03
      const sensitivity = vadSensitivityRef.current
      // Lower sensitivity = lower thresholds (more sensitive)
      const SILENCE_RMS = BASE_SILENCE_RMS * (1 + sensitivity)
      const SPEECH_RMS = BASE_SPEECH_RMS * (1 + sensitivity * 2)
      const VOICE_THRESHOLD = SPEECH_RMS
      const SILENCE_DURATION_MS = 300 // Ultra-fast response: 300ms silence threshold

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

        // Don't record while TTS is playing (prevent feedback loop)
        // BUT allow user barge-in: if user speaks during TTS, stop TTS and start recording
        if (isTTSPlayingRef.current) {
          // User barge-in: if user speaks loudly during TTS, interrupt TTS and start recording
          if (rms > VOICE_THRESHOLD * 1.5) { // Higher threshold for barge-in (user must speak louder)
            logger.info('User barge-in detected during TTS - stopping TTS and starting recording')
            stopTTS()
            // Fall through to start recording
          } else {
            // TTS is playing and no user barge-in - skip recording
            rafIdRef.current = requestAnimationFrame(loop)
            return
          }
        }

        if (rms > VOICE_THRESHOLD) {
          lastSpeechTimeRef.current = now
          
          if (!speakingRef.current) {
            speakingRef.current = true
            currentSpeechStartRef.current = now
            setStatusText('Speech detected, recording...')
            setState('recording')
            addLog('vad', 'Speech detected, starting recording')
            
            if (mediaRecorder.state !== 'recording') {
              currentAudioChunksRef.current = []
              
              // Ensure WebSocket is connected before starting recording
              if (!audioWebSocketRef.current) {
                logger.warn('WebSocket not initialized, cannot start recording')
                return
              }
              
              if (!audioWebSocketRef.current.isConnected()) {
                logger.warn('WebSocket not connected, attempting to connect...')
                // Try to connect with retry (non-blocking)
                const attemptConnection = async (retries = 3) => {
                  for (let i = 0; i < retries; i++) {
                    try {
                      await audioWebSocketRef.current!.connect()
                      logger.info('WebSocket connected successfully')
                      return true
                    } catch (err) {
                      logger.warn(`WebSocket connection attempt ${i + 1}/${retries} failed`, err)
                      if (i < retries - 1) {
                        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))) // Exponential backoff
                      }
                    }
                  }
                  return false
                }
                
                // Don't await - let it connect in background
                attemptConnection().then((connected) => {
                  if (!connected) {
                    logger.error('Failed to connect WebSocket after retries')
                    setIsProcessing(false)
                    if (pendingUserMessageRef.current) {
                      setChatMessages((prev) => prev.filter(msg => msg.id !== pendingUserMessageRef.current))
                      pendingUserMessageRef.current = null
                    }
                    setError(`Failed to connect to chatbot service. Please ensure the backend is running at ${config.apiUrl}`)
                  }
                }).catch((err) => {
                  logger.error('Connection attempt error', err)
                  setIsProcessing(false)
                  if (pendingUserMessageRef.current) {
                    setChatMessages((prev) => prev.filter(msg => msg.id !== pendingUserMessageRef.current))
                    pendingUserMessageRef.current = null
                  }
                  setError(`Failed to connect to chatbot service: ${err instanceof Error ? err.message : 'Unknown error'}`)
                })
                // Don't wait for connection - continue and let it connect in background
                // The recording will wait for connection before sending chunks
                return
              }
              
              try {
                mediaRecorder.start()
                logger.info('MediaRecorder started', { sessionId: sessionIdRef.current })
              } catch (err) {
                console.error('❌ Failed to start MediaRecorder', err)
                logger.error('Failed to start MediaRecorder', err)
                return
              }
            }
          }
        } else if (speakingRef.current) {
          // If TTS started while we were recording, stop immediately
          if (isTTSPlayingRef.current) {
            logger.info('TTS started during recording - stopping recording immediately')
            speakingRef.current = false
            if (mediaRecorder.state === 'recording') {
              try {
                mediaRecorder.stop()
              } catch (err) {
                logger.warn('Error stopping MediaRecorder when TTS started', err)
              }
            }
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

            setStatusText('Silence detected, processing question...')
            if (mediaRecorder.state === 'recording') {
              logger.info('Stopping recording due to silence', { sessionId })
              
              // ChatGPT style: Add user message immediately with placeholder
              // Will be updated with actual transcription when received
              const questionId = `user-${Date.now()}`
              currentQuestionRef.current = questionId
              setIsProcessing(true)
              
              // Add user message (ChatGPT shows user message immediately)
              setChatMessages((prev) => [
                ...prev,
                {
                  id: questionId,
                  type: 'user',
                  content: '🎤 [Transcribing...]',
                  timestamp: new Date()
                }
              ])
              pendingUserMessageRef.current = questionId
              
              // Send segment end to trigger chatbot response
              if (audioWebSocketRef.current && audioWebSocketRef.current.isConnected()) {
                logger.info('Sending segment_end to trigger chatbot response')
                audioWebSocketRef.current.sendSegmentEnd()
              } else {
                logger.error('WebSocket not connected, cannot send segment_end')
                setIsProcessing(false)
                // Remove the user message we just added
                setChatMessages((prev) => prev.filter(msg => msg.id !== questionId))
                pendingUserMessageRef.current = null
                setError('WebSocket not connected')
              }
              
              // Stop MediaRecorder
              setTimeout(() => {
                if (mediaRecorder.state === 'recording' && !isTTSPlayingRef.current) {
                  logger.info('Stopping MediaRecorder', { sessionId })
                  try {
                    mediaRecorder.stop()
                  } catch (err) {
                    logger.warn('Error stopping MediaRecorder', err)
                  }
                } else if (isTTSPlayingRef.current) {
                  logger.info('TTS started - MediaRecorder will be stopped by TTS handler')
                }
              }, 300)
            } else {
              logger.warn('MediaRecorder not recording when silence detected', {
                state: mediaRecorder.state,
                sessionId
              })
              // Still clear processing state if we were processing
              setIsProcessing(false)
              if (pendingUserMessageRef.current) {
                setChatMessages((prev) => prev.filter(msg => msg.id !== pendingUserMessageRef.current))
                pendingUserMessageRef.current = null
              }
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


  // TTS for chatbot responses
  const playTTS = (text: string) => {
    if (!text.trim() || !('speechSynthesis' in window)) {
      logger.warn('TTS not available or empty text')
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
        addLog('system', 'TTS started', `Playing: ${text.substring(0, 50)}...`)
        
        // Stop any active recording when TTS starts (prevent feedback loop)
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
          logger.info('Stopping recording because TTS started')
          try {
            mediaRecorderRef.current.stop()
            speakingRef.current = false
            setState('listening')
          } catch (err) {
            logger.warn('Failed to stop recording when TTS started', err)
          }
        }
      }

      utterance.onend = () => {
        setIsTTSPlaying(false)
        isTTSPlayingRef.current = false
        ttsUtteranceRef.current = null
        logger.info('TTS ended')
        addLog('system', 'TTS ended')
        
        // After TTS ends, allow recording to resume
        if (wakeModeRef.current) {
          setStatusText('Waiting for wake word: say "Hey AI" or "start"...')
          // Reset wake trigger to allow new wake word detection
          wakeTriggeredRef.current = false
        } else {
          setStatusText('Ready to listen...')
        }
      }

      utterance.onerror = (event) => {
        setIsTTSPlaying(false)
        isTTSPlayingRef.current = false
        ttsUtteranceRef.current = null
        logger.error('TTS error', event)
      }

      ttsUtteranceRef.current = utterance
      window.speechSynthesis.speak(utterance)
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
    logger.info('TTS stopped')
    addLog('system', 'TTS stopped')
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
        {/* Chatbot Interface */}
        <div className="mb-6 rounded-xl border-2" style={{ backgroundColor: 'rgba(31, 41, 55, 0.8)', borderColor: 'rgba(217, 119, 6, 0.5)', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.3)' }}>
          <div className="p-6 border-b-2" style={{ borderColor: 'rgba(217, 119, 6, 0.3)' }}>
            <div className="flex items-center gap-3">
              <span className="text-2xl">🤖</span>
            <div>
                <h2 className="text-lg font-bold text-gold-300">AI Chatbot</h2>
                <p className="text-xs text-gray-400">Voice-activated conversation assistant</p>
            </div>
              {isTTSPlaying && (
                <div className="ml-auto flex items-center gap-2 text-sm text-gold-400">
                  <span className="animate-pulse">🔊</span>
                  <span>Playing response...</span>
          </div>
              )}
            </div>
          </div>
          
          {/* Chat Messages */}
          <div 
            ref={chatContainerRef}
            className="p-6 max-h-96 overflow-y-auto flex flex-col" 
            style={{ minHeight: '200px' }}
          >
            {chatMessages.length === 0 && !isProcessing ? (
              <div className="text-center py-12 text-gray-400 flex-1 flex items-center justify-center">
                <div>
                  <p className="text-lg mb-2">👋 Welcome!</p>
                  <p className="text-sm">Say "Hey AI" or "start" to begin a conversation</p>
                </div>
              </div>
            ) : (
              <div className="space-y-4 flex flex-col">
                {chatMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[80%] rounded-lg p-4 border-2 ${
                        msg.type === 'user'
                          ? 'bg-gold-900/30 border-gold-600/50 text-gold-200'
                          : msg.error
                          ? 'bg-red-900/30 border-red-600/50 text-red-200'
                          : 'bg-dark-800 border-gold-500/50 text-gold-100'
                      }`}
                    >
                      <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                      {msg.type === 'assistant' && msg.backend && (
                        <p className="text-xs mt-2 opacity-70">
                          Powered by: {msg.backend}
                        </p>
                      )}
                      <p className="text-xs mt-2 opacity-50">
                        {msg.timestamp.toLocaleTimeString()}
                      </p>
                    </div>
                  </div>
                ))}
                {/* ChatGPT-style thinking indicator */}
                {isProcessing && (
                  <div className="flex justify-start">
                    <div className="max-w-[80%] rounded-lg p-4 border-2 bg-dark-800 border-gold-500/50">
                      <div className="flex items-center gap-2 text-gold-300">
                        <div className="flex gap-1">
                          <span className="w-2 h-2 bg-gold-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></span>
                          <span className="w-2 h-2 bg-gold-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></span>
                          <span className="w-2 h-2 bg-gold-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></span>
                        </div>
                        <span className="text-sm">Thinking...</span>
                      </div>
                    </div>
                  </div>
                )}
                {/* Invisible element at bottom for scroll target */}
                <div ref={chatMessagesEndRef} />
              </div>
            )}
          </div>
        </div>

        {/* Stats Bar */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
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

            {/* VAD Sensitivity Tuning */}
            <div className="rounded-xl p-6 border-2" style={{ backgroundColor: 'rgba(31, 41, 55, 0.7)', borderColor: 'rgba(217, 119, 6, 0.4)', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.3)' }}>
              <div className="mb-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-gold-300 uppercase tracking-wider">VAD Sensitivity</h3>
                  <span className="text-xs text-gold-400 font-semibold">
                    {Math.round(vadSensitivity * 100)}%
                      </span>
                  </div>
                <p className="text-xs text-gray-400 mb-3">
                  Adjust sensitivity: Lower = more sensitive (detects quieter speech), Higher = less sensitive (only loud speech)
                </p>
                  <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={vadSensitivity}
                    onChange={(e) => {
                    const newValue = parseFloat(e.target.value)
                    setVadSensitivity(newValue)
                    vadSensitivityRef.current = newValue
                  }}
                  className="w-full h-2 bg-dark-900 rounded-lg appearance-none cursor-pointer"
                    style={{
                    background: `linear-gradient(to right, #d97706 0%, #d97706 ${vadSensitivity * 100}%, #374151 ${vadSensitivity * 100}%, #374151 100%)`
                  }}
                />
                <div className="flex justify-between text-xs text-gray-500 mt-1">
                  <span>More Sensitive</span>
                  <span>Less Sensitive</span>
                  </div>
              </div>
            </div>


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
                          }[log.source]
                          const logIcon = {
                            system: '🔧',
                            wake: '👂',
                            vad: '🎤',
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
