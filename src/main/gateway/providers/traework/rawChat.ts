import { createParser } from 'eventsource-parser'
import type { TraeWorkAccountConfig, TraeWorkProviderSettings, UsageStats } from '../../types'
import { toErrorMessage } from '../../core/utils'
import { DEFAULT_TRAEWORK_CORE_BASE_URL, DEFAULT_TRAEWORK_RAW_CHAT_PATH } from './constants'
import { buildTraeWorkHeaders } from './headers'
import { joinUrl, traeWorkFetch } from './http'

export interface TraeWorkStreamEvent {
  event: string
  data: any
}

export interface TraeWorkToolCall {
  id?: string
  name: string
  input: any
  argumentsText?: string
}

export interface TraeWorkChatResult {
  text: string
  reasoning: string
  usage?: UsageStats
  toolCalls?: TraeWorkToolCall[]
  finishReason?: string
  sessionId?: string
  rawEvents: TraeWorkStreamEvent[]
}

export class TraeWorkUpstreamError extends Error {
  constructor(
    message: string,
    public readonly status = 0,
    public readonly upstreamBody?: string
  ) {
    super(message)
    this.name = 'TraeWorkUpstreamError'
  }
}

export interface TraeWorkChatOptions {
  settings: TraeWorkProviderSettings
  account: TraeWorkAccountConfig
  token: string
  payload: any
}

/**
 * Opens POST /api/agent/v3/llm_utils_chat and yields upstream SSE events as
 * they arrive. Events of interest: output{response,reasoning_content,
 * tool_calls}, token_usage, done{finish_reason}, error{code,message}.
 * Queue/progress events are yielded so callers can log, but carry no content.
 */
export async function* streamTraeWorkChat(
  options: TraeWorkChatOptions
): AsyncGenerator<TraeWorkStreamEvent> {
  const base =
    options.account.coreBaseUrl || options.settings.coreBaseUrl || DEFAULT_TRAEWORK_CORE_BASE_URL
  const path = options.settings.rawChatPath || DEFAULT_TRAEWORK_RAW_CHAT_PATH
  const url = joinUrl(base, path)
  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: buildTraeWorkHeaders(options.token, options.settings, options.account),
      body: JSON.stringify(options.payload)
    },
    options.settings,
    timeoutMs(options.settings.firstTokenTimeoutSeconds, 60),
    'TraeWork response header timeout'
  )

  if (!response.ok) {
    const text = await response.text().catch((error) => toErrorMessage(error))
    throw new TraeWorkUpstreamError(
      `TraeWork chat failed: HTTP ${response.status} ${text.slice(0, 800)}`,
      response.status,
      text
    )
  }

  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('text/event-stream')) {
    const text = await response.text().catch((error) => toErrorMessage(error))
    const parsed = tryJson(text)
    if (isErrorPayload(parsed)) {
      throw new TraeWorkUpstreamError(
        `TraeWork chat error: ${formatPayload(parsed).slice(0, 800)}`,
        response.status,
        text
      )
    }
    yield { event: 'output', data: parsed ?? text }
    return
  }

  yield* readTraeWorkSse(response.body, options.settings)
}

/** Aggregates the upstream event stream into a single result (non-stream path). */
export async function collectTraeWorkChat(
  options: TraeWorkChatOptions
): Promise<TraeWorkChatResult> {
  const rawEvents: TraeWorkStreamEvent[] = []
  let text = ''
  let reasoning = ''
  let usage: UsageStats | undefined
  let finishReason: string | undefined
  let sessionId: string | undefined
  let lastError: any
  const toolAcc = new Map<string, ToolCallAccumulator>()
  for await (const item of streamTraeWorkChat(options)) {
    rawEvents.push(item)
    const payload = item.data
    if (item.event === 'error' || isErrorPayload(payload)) {
      lastError = payload
      continue
    }
    if (item.event === 'metadata' && payload && typeof payload === 'object') {
      sessionId = pickString(payload.session_id) || sessionId
      continue
    }
    if (item.event === 'output') {
      const chunk = pickText(payload?.response)
      if (chunk) text += chunk
      const reasoningChunk = pickText(payload?.reasoning_content)
      if (reasoningChunk) reasoning += reasoningChunk
      mergeToolCalls(payload?.tool_calls, toolAcc)
      continue
    }
    if (item.event === 'token_usage') {
      usage = extractUsage(payload) ?? usage
      continue
    }
    if (item.event === 'done') {
      finishReason = pickString(payload?.finish_reason) || finishReason
    }
  }
  const toolCalls = finalizeToolCalls(toolAcc)
  if (lastError && !text && !toolCalls.length) {
    throw new TraeWorkUpstreamError(
      `TraeWork stream error: ${formatPayload(lastError).slice(0, 800)}`,
      200
    )
  }
  return {
    text,
    reasoning,
    usage,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    finishReason,
    sessionId,
    rawEvents
  }
}

async function* readTraeWorkSse(
  body: ReadableStream<Uint8Array> | null,
  settings: TraeWorkProviderSettings
): AsyncGenerator<TraeWorkStreamEvent> {
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  const queue: TraeWorkStreamEvent[] = []
  const parser = createParser({
    maxBufferSize: 4 * 1024 * 1024,
    onEvent: (msg: { event?: string; data: string }) => {
      queue.push({ event: msg.event || 'message', data: tryJson(msg.data) })
    }
  })
  const idleMs = timeoutMs(settings.streamingReadTimeoutSeconds, 120)
  try {
    while (true) {
      const result = await readWithTimeout(
        reader,
        idleMs,
        () =>
          new TraeWorkUpstreamError(
            `TraeWork stream idle timeout after ${formatTimeoutSeconds(idleMs)}s without data`
          )
      )
      if (result.done) {
        if (queue.length) {
          yield* flush(queue)
        }
        break
      }
      parser.feed(decoder.decode(result.value, { stream: true }))
      if (queue.length) yield* flush(queue)
    }
    parser.reset({ consume: true })
    if (queue.length) yield* flush(queue)
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* ignore */
    }
  }
}

function* flush(queue: TraeWorkStreamEvent[]): Generator<TraeWorkStreamEvent> {
  while (queue.length) yield queue.shift()!
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  settings: TraeWorkProviderSettings,
  ms: number,
  label: string
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await traeWorkFetch(url, { ...init, signal: controller.signal }, settings)
  } catch (error) {
    if (controller.signal.aborted) {
      throw new TraeWorkUpstreamError(`${label} after ${formatTimeoutSeconds(ms)}s`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeout: number,
  buildError: () => Error
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
        timer = setTimeout(() => reject(buildError()), timeout)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

interface ToolCallAccumulator {
  id?: string
  index?: number
  name?: string
  argumentsText: string
  input?: any
}

/**
 * Upstream tool_calls entries: {index, id, type:'function',
 * function_call:{name, arguments, partial?}}. arguments may arrive as one
 * complete JSON string or as incremental chunks; accumulate per index/id.
 */
function mergeToolCalls(value: any, acc: Map<string, ToolCallAccumulator>): void {
  for (const item of asArray(value)) {
    if (!item || typeof item !== 'object') continue
    const index = typeof item.index === 'number' ? item.index : undefined
    const id = pickString(item.id, item.tool_call_id)
    const key = id || (index !== undefined ? `index:${index}` : `item:${acc.size}`)
    const current: ToolCallAccumulator = acc.get(key) || { id, index, argumentsText: '' }
    if (id) current.id = id
    if (index !== undefined) current.index = index
    const name = pickString(item.function_call?.name, item.function?.name, item.name)
    if (name) current.name = name
    const args = item.function_call?.arguments ?? item.function?.arguments ?? item.arguments
    if (args !== undefined && args !== null) {
      const argText = typeof args === 'string' ? args : stringifyArgs(args)
      if (item.function_call?.partial === false || !current.argumentsText) {
        current.argumentsText = argText
      } else {
        current.argumentsText += argText
      }
      if (typeof args === 'object') current.input = args
    }
    acc.set(key, current)
  }
}

function finalizeToolCalls(acc: Map<string, ToolCallAccumulator>): TraeWorkToolCall[] {
  const out: TraeWorkToolCall[] = []
  for (const item of [...acc.values()].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))) {
    if (!item.name) continue
    out.push({
      id: item.id,
      name: item.name,
      input: item.input ?? parseArgs(item.argumentsText),
      argumentsText: item.argumentsText || undefined
    })
  }
  return out
}

function extractUsage(payload: any): UsageStats | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const raw = payload.token_usage || payload.usage || payload
  const inputTokens = numberFrom(raw.prompt_tokens ?? raw.input_tokens ?? raw.promptTokens)
  const outputTokens = numberFrom(
    raw.completion_tokens ?? raw.output_tokens ?? raw.completionTokens
  )
  if (!inputTokens && !outputTokens) return undefined
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: numberFrom(raw.cache_read_input_tokens ?? raw.cache_read_tokens),
    cacheWrite5mTokens: numberFrom(raw.cache_creation_input_tokens),
    estimated: false
  }
}

function isErrorPayload(payload: any): boolean {
  if (!payload || payload === '[DONE]') return false
  if (typeof payload === 'string') return /unauthorized|auth|error|quota|rate limit/i.test(payload)
  const code = payload.code ?? payload.Code ?? payload.error?.code
  if (
    code !== undefined &&
    code !== null &&
    !(code === 0 || code === '0' || code === 'OK' || code === 'ok')
  )
    return true
  return Boolean(payload.error && typeof payload.error === 'object' && !payload.choices)
}

function tryJson(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function parseArgs(value: string): any {
  if (!value) return {}
  try {
    return JSON.parse(value)
  } catch {
    return { arguments: value }
  }
}

function stringifyArgs(value: any): string {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

function asArray(value: any): any[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function pickText(value: unknown): string {
  return typeof value === 'string' && value.length ? value : ''
}

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return ''
}

function numberFrom(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0
  return Number.isFinite(n) && n > 0 ? n : 0
}

function timeoutMs(seconds: unknown, fallback: number): number {
  const n = typeof seconds === 'number' ? seconds : Number(seconds)
  const safe = Number.isFinite(n) && n > 0 ? n : fallback
  return Math.max(1, Math.ceil(safe * 1000))
}

function formatTimeoutSeconds(ms: number): string {
  const seconds = ms / 1000
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(3).replace(/0+$/, '')
}

function formatPayload(payload: any): string {
  try {
    return typeof payload === 'string' ? payload : JSON.stringify(payload)
  } catch {
    return String(payload)
  }
}
