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

export async function uploadFile(
  file: Blob,
  filename: string = 'recording.webm'
): Promise<{ status: string; filename: string }> {
  const formData = new FormData()
  formData.append('file', file, filename)

  const response = await fetchWithRetry(`${config.apiUrl}/upload`, {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Upload failed: ${response.status} ${errorText}`)
  }

  return response.json()
}

export async function uploadTextFile(
  text: string,
  filename: string = 'transcription.txt'
): Promise<{ status: string; filename: string }> {
  const formData = new FormData()
  const blob = new Blob([text], { type: 'text/plain' })
  formData.append('file', blob, filename)

  const response = await fetchWithRetry(`${config.apiUrl}/upload`, {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Upload failed: ${response.status} ${errorText}`)
  }

  return response.json()
}

export async function sendTranscriptionText(
  text: string,
  sessionId: string
): Promise<{ status: string; message: string }> {
  const response = await fetchWithRetry(`${config.apiUrl}/transcription`, {
    method: 'POST',
    body: JSON.stringify({ text, session_id: sessionId }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to send transcription: ${response.status} ${errorText}`)
  }

  return response.json()
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

export interface Recording {
  filename: string
  size: number
  modified: string
}

export interface TranscriptionLog {
  session_id: string
  filename: string
  size: number
  modified: string
  entry_count: number
  first_entry: string
}

export async function getRecordings(): Promise<Recording[]> {
  const response = await fetchWithRetry(`${config.apiUrl}/recordings`, {
    method: 'GET',
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to fetch recordings: ${response.status} ${errorText}`)
  }

  const data = await response.json()
  return data.recordings || []
}

export async function getTranscriptionLogs(): Promise<TranscriptionLog[]> {
  const response = await fetchWithRetry(`${config.apiUrl}/transcription-logs`, {
    method: 'GET',
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to fetch transcription logs: ${response.status} ${errorText}`)
  }

  const data = await response.json()
  return data.logs || []
}

export interface TranscriptionLogContent {
  session_id: string
  filename: string
  content: string
  size: number
  modified: string
}

export async function getTranscriptionLogContent(sessionId: string): Promise<TranscriptionLogContent> {
  const response = await fetchWithRetry(`${config.apiUrl}/transcription-logs/${sessionId}`, {
    method: 'GET',
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to fetch transcription log: ${response.status} ${errorText}`)
  }

  return response.json()
}

export async function downloadAudioFile(filename: string): Promise<Blob> {
  const response = await fetchWithRetry(`${config.apiUrl}/recordings/${filename}`, {
    method: 'GET',
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to download audio: ${response.status} ${errorText}`)
  }

  return response.blob()
}

