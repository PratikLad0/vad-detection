import { config } from '../config'
import { logger } from './logger'

interface RetryOptions {
  maxRetries?: number
  retryDelay?: number
  retryableStatuses?: number[]
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  retryDelay: 1000,
  retryableStatuses: [408, 429, 500, 502, 503, 504],
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retryOptions: RetryOptions = {}
): Promise<Response> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...retryOptions }
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      // Don't set Content-Type for FormData - browser will set it with boundary
      const isFormData = options.body instanceof FormData
      const headers: HeadersInit = isFormData
        ? { ...options.headers }
        : {
            'Content-Type': 'application/json',
            ...options.headers,
          }

      const response = await fetch(url, {
        ...options,
        headers,
      })

      // If successful or non-retryable error, return immediately
      if (response.ok || !opts.retryableStatuses.includes(response.status)) {
        return response
      }

      // If retryable error and not last attempt
      if (attempt < opts.maxRetries) {
        const delay = opts.retryDelay * Math.pow(2, attempt) // Exponential backoff
        logger.warn(`Request failed with status ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${opts.maxRetries})`)
        await sleep(delay)
        continue
      }

      return response
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (attempt < opts.maxRetries) {
        const delay = opts.retryDelay * Math.pow(2, attempt)
        logger.warn(`Request failed: ${lastError.message}, retrying in ${delay}ms (attempt ${attempt + 1}/${opts.maxRetries})`)
        await sleep(delay)
        continue
      }
    }
  }

  throw lastError || new Error('Request failed after all retries')
}

export async function healthCheck(): Promise<boolean> {
  try {
    const response = await fetchWithRetry(`${config.apiUrl}/health`, {
      method: 'GET',
    }, { maxRetries: 1 })
    return response.ok
  } catch {
    return false
  }
}

// WebSocket for real-time audio streaming
export interface TranscriptionMessage {
  text: string
  speaker_label?: string
  speaker_id?: number
}

export interface ChatbotResponse {
  response: string | null
  backend_used?: string
  error?: string | null
  transcription?: string  // User's question transcription
}

export class AudioWebSocket {
  private ws: WebSocket | null = null
  private sessionId: string | null = null
  private onTranscription: ((message: TranscriptionMessage) => void) | null = null
  private onChatbotResponse: ((response: ChatbotResponse) => void) | null = null
  private onError: ((error: Error) => void) | null = null
  
  // Robustness features (like web speech service)
  private reconnectTimeout: number | null = null
  private reconnectAttempts: number = 0
  private maxReconnectAttempts: number = 10 // Allow many retries like web speech
  private reconnectDelay: number = 2000 // Start with 2 seconds
  private isIntentionallyDisconnected: boolean = false
  private shouldAutoReconnect: boolean = true
  private connectionPromise: Promise<void> | null = null

  constructor(
    sessionId: string,
    onTranscription: (message: TranscriptionMessage) => void,
    onChatbotResponse?: (response: ChatbotResponse) => void,
    onError?: (error: Error) => void
  ) {
    this.sessionId = sessionId
    this.onTranscription = onTranscription
    this.onChatbotResponse = onChatbotResponse || null
    this.onError = onError || null
  }

  async connect(): Promise<void> {
    // If already connecting, return the existing promise
    if (this.connectionPromise) {
      return this.connectionPromise
    }

    // If already connected, return immediately
    if (this.isConnected()) {
      logger.debug('WebSocket already connected')
      return Promise.resolve()
    }

    // Clear any pending reconnect
    if (this.reconnectTimeout !== null) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    this.connectionPromise = new Promise((resolve, reject) => {
      // Get API URL from config
      const apiUrl = config.apiUrl
      const wsUrl = apiUrl.replace('http://', 'ws://').replace('https://', 'wss://')
      const fullWsUrl = `${wsUrl}/ws/audio`
      
      logger.info('Attempting WebSocket connection', { 
        url: fullWsUrl, 
        apiUrl,
        attempt: this.reconnectAttempts + 1,
        maxAttempts: this.maxReconnectAttempts
      })
      
      // Set a connection timeout
      const connectionTimeout = setTimeout(() => {
        if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
          logger.error('WebSocket connection timeout', { url: fullWsUrl })
          if (this.ws) {
            this.ws.close()
            this.ws = null
          }
          this.connectionPromise = null
          // Auto-reconnect on timeout (like web speech service)
          this.scheduleReconnect('Connection timeout')
          reject(new Error(`WebSocket connection timeout. Please ensure the backend server is running at ${apiUrl}`))
        }
      }, 10000) // 10 second timeout

      try {
        this.ws = new WebSocket(fullWsUrl)
      } catch (err) {
        clearTimeout(connectionTimeout)
        const errorMsg = err instanceof Error ? err.message : 'Unknown error'
        logger.error('Failed to create WebSocket', { error: errorMsg, url: fullWsUrl })
        this.connectionPromise = null
        // Auto-reconnect on creation failure
        this.scheduleReconnect(`Failed to create WebSocket: ${errorMsg}`)
        reject(new Error(`Failed to create WebSocket connection: ${errorMsg}. Check if backend is running at ${apiUrl}`))
        return
      }

      this.ws.onopen = () => {
        clearTimeout(connectionTimeout)
        // Reset reconnect attempts on successful connection
        this.reconnectAttempts = 0
        this.reconnectDelay = 2000 // Reset delay
        this.connectionPromise = null
        logger.info('WebSocket connected successfully', { 
          url: fullWsUrl,
          reconnectAttempts: this.reconnectAttempts
        })
        // Send session ID
        if (this.ws && this.sessionId) {
          try {
            this.ws.send(JSON.stringify({
              type: 'session',
              session_id: this.sessionId,
            }))
            logger.info('Session ID sent to server', { sessionId: this.sessionId })
          } catch (err) {
            logger.error('Failed to send session ID', err)
          }
        }
        resolve()
      }

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data)
          
          if (message.type === 'session_ack') {
            logger.info('Session acknowledged by server', { sessionId: message.session_id })
          } else if (message.type === 'transcription') {
            if (this.onTranscription && message.text) {
              logger.info('Received transcription from WebSocket', { 
                textLength: message.text.length,
                preview: message.text.substring(0, 50),
                speaker: message.speaker_label || 'Unknown'
              })
              this.onTranscription({
                text: message.text,
                speaker_label: message.speaker_label,
                speaker_id: message.speaker_id
              })
            } else {
              logger.warn('Transcription received but callback not available or text is empty', {
                hasCallback: !!this.onTranscription,
                hasText: !!message.text
              })
            }
          } else if (message.type === 'chatbot_response') {
            if (this.onChatbotResponse) {
              logger.info('Received chatbot response from WebSocket', {
                hasResponse: !!message.response,
                hasTranscription: !!message.transcription,
                backend: message.backend_used,
                error: message.error
              })
              this.onChatbotResponse({
                response: message.response || null,
                backend_used: message.backend_used,
                error: message.error || null,
                transcription: message.transcription || undefined
              })
            }
          } else if (message.type === 'chunk_received') {
            logger.debug('Audio chunk acknowledged by server')
          } else if (message.type === 'segment_processed') {
            logger.info('Speech segment processed by server')
          } else if (message.type === 'error') {
            const error = new Error(message.message || 'WebSocket error')
            logger.error('WebSocket error message received', { message: message.message })
            if (this.onError) {
              this.onError(error)
            }
          } else {
            logger.debug('Unknown WebSocket message type', { type: message.type })
          }
        } catch (err) {
          logger.error('Failed to parse WebSocket message', err)
        }
      }

      this.ws.onerror = (error) => {
        clearTimeout(connectionTimeout)
        logger.error('WebSocket error event', { 
          error, 
          url: fullWsUrl,
          readyState: this.ws?.readyState,
          apiUrl,
          reconnectAttempts: this.reconnectAttempts
        })
        // Don't reject immediately - let onclose handle reconnection
        // This matches web speech service behavior (errors are handled gracefully)
      }

      this.ws.onclose = (event) => {
        clearTimeout(connectionTimeout)
        this.connectionPromise = null
        logger.info('WebSocket closed', { 
          code: event.code, 
          reason: event.reason, 
          wasClean: event.wasClean,
          url: fullWsUrl,
          intentionallyDisconnected: this.isIntentionallyDisconnected
        })
        
        // Don't auto-reconnect if intentionally disconnected
        if (this.isIntentionallyDisconnected) {
          logger.info('WebSocket intentionally disconnected - not auto-reconnecting')
          this.isIntentionallyDisconnected = false
          return
        }

        // Handle different close codes (like web speech service handles different errors)
        if (event.code === 1000 || event.code === 1001) {
          // Normal closure - don't reconnect
          logger.info('WebSocket closed normally')
          return
        }

        // Unexpected closure - auto-reconnect (like web speech service auto-restarts)
        if (this.shouldAutoReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
          logger.warn('WebSocket closed unexpectedly - scheduling reconnect', { 
            code: event.code, 
            reason: event.reason || 'No reason provided',
            attempt: this.reconnectAttempts + 1
          })
          this.scheduleReconnect(event.reason || `Unexpected close (code: ${event.code})`)
        } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          logger.error('WebSocket max reconnection attempts reached', {
            maxAttempts: this.maxReconnectAttempts
          })
          const errorMessage = `WebSocket connection failed after ${this.maxReconnectAttempts} attempts. Please ensure:
1. Backend server is running at ${apiUrl}
2. Backend server is accessible from your browser
3. CORS is properly configured
4. No firewall is blocking the connection`
          if (this.onError) {
            this.onError(new Error(errorMessage))
          }
        }
      }
    })

    return this.connectionPromise
  }

  private scheduleReconnect(reason: string): void {
    // Prevent multiple simultaneous reconnection attempts
    if (this.reconnectTimeout !== null) {
      logger.debug('Reconnection already scheduled, skipping')
      return
    }

    if (!this.shouldAutoReconnect) {
      logger.debug('Auto-reconnect disabled, not scheduling reconnect')
      return
    }

    this.reconnectAttempts++
    const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000) // Max 30 seconds
    
    logger.info('Scheduling WebSocket reconnection', {
      attempt: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts,
      delayMs: delay,
      reason
    })

    this.reconnectTimeout = window.setTimeout(() => {
      this.reconnectTimeout = null
      // Only reconnect if we should and we're not already connected
      if (this.shouldAutoReconnect && !this.isConnected()) {
        logger.info('Attempting WebSocket reconnection', {
          attempt: this.reconnectAttempts,
          maxAttempts: this.maxReconnectAttempts
        })
        this.connect().catch((err) => {
          logger.error('Reconnection attempt failed', err)
          // Will schedule another reconnect in onclose if needed
        })
      }
    }, delay)
  }

  sendAudioChunk(chunk: Blob): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn('WebSocket not connected, cannot send audio chunk - will auto-reconnect', {
        readyState: this.ws?.readyState,
        isConnected: this.isConnected()
      })
      // If auto-reconnect is enabled and we're not connected, try to reconnect
      if (this.shouldAutoReconnect && !this.isConnected() && !this.connectionPromise) {
        logger.info('Attempting to reconnect WebSocket for audio chunk')
        this.connect().catch((err) => {
          logger.warn('Failed to reconnect for audio chunk', err)
          // Auto-reconnect will continue trying
        })
      }
      return
    }

    // Convert blob to base64
    const reader = new FileReader()
    reader.onloadend = () => {
      if (reader.result && typeof reader.result === 'string') {
        const base64 = reader.result.split(',')[1] // Remove data:audio/webm;base64, prefix
        try {
          this.ws?.send(JSON.stringify({
            type: 'audio_chunk',
            data: base64,
          }))
        } catch (err) {
          logger.error('Failed to send audio chunk', err)
          // If send fails, try to reconnect
          if (this.shouldAutoReconnect && !this.connectionPromise) {
            this.scheduleReconnect('Send failed')
          }
        }
      }
    }
    reader.readAsDataURL(chunk)
  }

  sendSegmentEnd(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn('WebSocket not connected, cannot send segment end - will auto-reconnect', {
        readyState: this.ws?.readyState,
        isConnected: this.isConnected()
      })
      // If auto-reconnect is enabled and we're not connected, try to reconnect
      if (this.shouldAutoReconnect && !this.isConnected() && !this.connectionPromise) {
        logger.info('Attempting to reconnect WebSocket for segment end')
        this.connect().catch((err) => {
          logger.warn('Failed to reconnect for segment end', err)
          // Auto-reconnect will continue trying
        })
      }
      return
    }

    try {
      this.ws.send(JSON.stringify({
        type: 'segment_end',
      }))
    } catch (err) {
      logger.error('Failed to send segment end', err)
      // If send fails, try to reconnect
      if (this.shouldAutoReconnect && !this.connectionPromise) {
        this.scheduleReconnect('Send segment_end failed')
      }
    }
  }

  disconnect(): void {
    logger.info('Disconnecting WebSocket intentionally')
    this.isIntentionallyDisconnected = true
    this.shouldAutoReconnect = false
    
    // Clear any pending reconnection
    if (this.reconnectTimeout !== null) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    
    if (this.ws) {
      try {
        this.ws.close(1000, 'Intentional disconnect') // Normal closure code
      } catch (err) {
        logger.warn('Error closing WebSocket', err)
      }
      this.ws = null
    }
    
    this.connectionPromise = null
    this.reconnectAttempts = 0
  }

  enableAutoReconnect(): void {
    logger.info('Enabling WebSocket auto-reconnect')
    this.shouldAutoReconnect = true
  }

  disableAutoReconnect(): void {
    logger.info('Disabling WebSocket auto-reconnect')
    this.shouldAutoReconnect = false
    if (this.reconnectTimeout !== null) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  getReconnectAttempts(): number {
    return this.reconnectAttempts
  }

  resetReconnectState(): void {
    logger.info('Resetting WebSocket reconnect state')
    this.reconnectAttempts = 0
    this.reconnectDelay = 2000
    if (this.reconnectTimeout !== null) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
  }
}

