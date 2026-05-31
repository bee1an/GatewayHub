import type { TraeProviderSettings, UsageStats } from '../../types'
import { toErrorMessage } from '../../core/utils'
import { DEFAULT_TRAE_CORE_BASE_URL, DEFAULT_TRAE_RAW_CHAT_PATH } from './constants'
import { buildTraeIdeHeaders } from './headers'
import { joinUrl, traeFetch } from './http'

export interface TraeRawChatResult {
  text: string
  usage?: UsageStats
  toolCalls?: TraeToolCall[]
  rawEvents: Array<{ event?: string; data: any }>
}

export interface TraeToolCall {
  id?: string
  name: string
  input: any
}

export class TraeUpstreamError extends Error {
  constructor(
    message: string,
    public readonly status = 0,
    public readonly upstreamBody?: string
  ) {
    super(message)
    this.name = 'TraeUpstreamError'
  }
}

export async function runTraeRawChat(options: {
  settings: TraeProviderSettings
  accountCoreBaseUrl?: string
  token: string
  payload: any
}): Promise<TraeRawChatResult> {
  const base =
    options.accountCoreBaseUrl || options.settings.coreBaseUrl || DEFAULT_TRAE_CORE_BASE_URL
  const path = options.settings.rawChatPath || DEFAULT_TRAE_RAW_CHAT_PATH
  const url = joinUrl(base, path)
  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        accept: 'text/event-stream, application/json',
        'content-type': 'application/json',
        ...buildTraeIdeHeaders(options.token, options.settings),
        'x-app-function': 'chat',
        'x-ide-function': 'chat'
      },
      body: JSON.stringify(options.payload)
    },
    options.settings,
    timeoutMs(options.settings.firstTokenTimeoutSeconds, 60),
    'Trae response header timeout'
  )

  const contentType = response.headers.get('content-type') || ''
  if (!response.ok) {
    const text = await response.text().catch((error) => toErrorMessage(error))
    throw new TraeUpstreamError(
      `Trae raw chat failed: HTTP ${response.status} ${text.slice(0, 800)}`,
      response.status,
      text
    )
  }

  if (!contentType.includes('text/event-stream')) {
    const text = await response.text().catch((error) => toErrorMessage(error))
    const parsed = tryJson(text)
    if (isErrorPayload(parsed)) {
      throw new TraeUpstreamError(
        `Trae raw chat error: ${formatPayload(parsed).slice(0, 800)}`,
        response.status,
        text
      )
    }
    const extracted = extractTextFromPayload(parsed)
    const toolAcc = new Map<string, ToolCallAccumulator>()
    mergeToolCallsFromPayload(parsed, toolAcc)
    const toolCalls = finalizeToolCalls(toolAcc)
    return {
      text: extracted || (typeof parsed === 'string' ? parsed : ''),
      usage: extractUsage(parsed),
      toolCalls: toolCalls.length ? toolCalls : undefined,
      rawEvents: [{ data: parsed ?? text }]
    }
  }

  const streamText = await readTraeSseStream(response.body, options.settings)
  return parseTraeSse(streamText, response.status)
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  settings: TraeProviderSettings,
  ms: number,
  label: string
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await traeFetch(url, { ...init, signal: controller.signal }, settings)
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${label} after ${formatTimeoutSeconds(ms)}s`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export function parseTraeSse(input: string, status = 200): TraeRawChatResult {
  const rawEvents = parseSseBlocks(input)
  let text = ''
  let usage: UsageStats | undefined
  let lastError: any
  const toolAcc = new Map<string, ToolCallAccumulator>()
  for (const item of rawEvents) {
    const eventName = item.event || eventNameFromPayload(item.data)
    if (eventName === 'error' || isErrorPayload(item.data)) {
      lastError = item.data
      continue
    }
    mergeToolCallsFromPayload(item.data, toolAcc)
    const nextUsage = extractUsage(item.data)
    if (nextUsage) usage = nextUsage
    const chunk = extractTextFromPayload(item.data)
    if (chunk) text = appendDelta(text, chunk)
  }
  if (lastError && !text) {
    throw new TraeUpstreamError(
      `Trae stream error: ${formatPayload(lastError).slice(0, 800)}`,
      status,
      input
    )
  }
  const toolCalls = finalizeToolCalls(toolAcc)
  return { text, usage, toolCalls: toolCalls.length ? toolCalls : undefined, rawEvents }
}

export async function readTraeSseStream(
  body: ReadableStream<Uint8Array> | null,
  settings: TraeProviderSettings
): Promise<string> {
  if (!body) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  const firstTokenMs = timeoutMs(settings.firstTokenTimeoutSeconds, 60)
  const idleMs = timeoutMs(settings.streamingReadTimeoutSeconds, 120)
  let output = ''
  let cancelled = false
  try {
    const first = await readWithTimeout(
      reader,
      firstTokenMs,
      () => new Error(`No Trae token within ${formatTimeoutSeconds(firstTokenMs)}s`)
    )
    if (first.done) return ''
    output += decoder.decode(first.value, { stream: true })
    while (true) {
      const result = await readWithTimeout(
        reader,
        idleMs,
        () =>
          new Error(`Trae stream idle timeout after ${formatTimeoutSeconds(idleMs)}s without data`)
      )
      if (result.done) break
      output += decoder.decode(result.value, { stream: true })
    }
    output += decoder.decode()
    return output
  } catch (error) {
    cancelled = true
    try {
      await reader.cancel()
    } catch {
      /* ignore */
    }
    throw error
  } finally {
    if (!cancelled) {
      try {
        reader.releaseLock()
      } catch {
        /* ignore */
      }
    }
  }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  buildError: () => Error
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
        timer = setTimeout(() => reject(buildError()), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function parseSseBlocks(input: string): Array<{ event?: string; data: any }> {
  const blocks = input.split(/\r?\n\r?\n/)
  const out: Array<{ event?: string; data: any }> = []
  for (const block of blocks) {
    if (!block.trim()) continue
    let event: string | undefined
    const dataLines: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    if (!dataLines.length) continue
    const dataText = dataLines.join('\n')
    if (dataText === '[DONE]') {
      out.push({ event: event || 'done', data: '[DONE]' })
      continue
    }
    out.push({ event, data: tryJson(dataText) })
  }
  return out
}

function tryJson(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function eventNameFromPayload(payload: any): string {
  return String(payload?.event || payload?.type || payload?.name || '').toLowerCase()
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
  const type = String(payload.type || payload.event || '').toLowerCase()
  return type === 'error' || Boolean(payload.error && !payload.choices)
}

function extractTextFromPayload(payload: any): string {
  if (!payload || payload === '[DONE]') return ''
  if (typeof payload === 'string') return ''
  const candidates = [
    payload.text,
    payload.content,
    payload.delta,
    payload.answer,
    payload.output,
    payload.response,
    payload.delta?.content,
    payload.delta?.text,
    payload.delta?.message?.content,
    payload.message?.content,
    payload.data?.text,
    payload.data?.content,
    payload.data?.delta,
    payload.data?.delta?.content,
    payload.data?.delta?.text,
    payload.data?.answer,
    payload.data?.output,
    payload.data?.response,
    payload.choices?.[0]?.delta?.content,
    payload.choices?.[0]?.message?.content,
    payload.Result?.text,
    payload.Result?.content,
    payload.result?.text,
    payload.result?.content
  ]
  for (const value of candidates) {
    const text = stringifyContent(value)
    if (text) return text
  }
  return ''
}

interface ToolCallAccumulator {
  id?: string
  index?: number
  name?: string
  argumentsText: string
  input?: any
}

function mergeToolCallsFromPayload(payload: any, acc: Map<string, ToolCallAccumulator>): void {
  if (!payload || typeof payload !== 'object') return
  for (const choice of asArray(payload.choices)) {
    mergeOpenAiToolCalls(choice?.delta?.tool_calls, acc, false)
    mergeOpenAiToolCalls(choice?.message?.tool_calls, acc, true)
  }
  mergeOpenAiToolCalls(payload.tool_calls, acc, true)
  mergeOpenAiToolCalls(payload.data?.tool_calls, acc, true)
  mergeAnthropicToolUses(payload.content, acc)
  mergeAnthropicToolUses(payload.message?.content, acc)
  mergeAnthropicToolUses(payload.data?.content, acc)
  mergeAnthropicToolEvent(payload, acc)
  mergeAnthropicToolEvent(payload.data, acc)
}

function mergeOpenAiToolCalls(
  value: any,
  acc: Map<string, ToolCallAccumulator>,
  complete: boolean
) {
  for (const item of asArray(value)) {
    if (!item || typeof item !== 'object') continue
    const index = typeof item.index === 'number' ? item.index : undefined
    const id = pickString(item.id, item.tool_call_id)
    const key = resolveToolCallKey(acc, id, index)
    const current: ToolCallAccumulator = acc.get(key) || { id, index, argumentsText: '' }
    if (id) current.id = id
    if (index !== undefined) current.index = index
    const name = pickString(item.function?.name, item.name)
    if (name) current.name = name
    const args = item.function?.arguments ?? item.arguments ?? item.input
    if (args !== undefined) {
      const text = stringifyArguments(args)
      if (complete) current.argumentsText = text
      else current.argumentsText += text
      if (typeof args === 'object' && args !== null) current.input = args
    }
    acc.set(key, current)
  }
}

function resolveToolCallKey(
  acc: Map<string, ToolCallAccumulator>,
  id: string,
  index: number | undefined
): string {
  if (id) return id
  if (index !== undefined) {
    for (const [key, item] of acc) {
      if (item.index === index) return key
    }
    return `index:${index}`
  }
  return `item:${acc.size}`
}

function mergeAnthropicToolUses(value: any, acc: Map<string, ToolCallAccumulator>): void {
  for (const item of asArray(value)) {
    if (!item || typeof item !== 'object' || item.type !== 'tool_use') continue
    const id = pickString(item.id, item.tool_use_id)
    const key = id || `item:${acc.size}`
    acc.set(key, {
      id,
      name: pickString(item.name),
      argumentsText: stringifyArguments(item.input ?? {}),
      input: item.input ?? {}
    })
  }
}

function mergeAnthropicToolEvent(payload: any, acc: Map<string, ToolCallAccumulator>): void {
  if (!payload || typeof payload !== 'object') return
  const type = String(payload.type || payload.event || '').toLowerCase()
  const index = typeof payload.index === 'number' ? payload.index : undefined
  if (type === 'content_block_start' && payload.content_block?.type === 'tool_use') {
    const block = payload.content_block
    const id = pickString(block.id, block.tool_use_id)
    const key = resolveToolCallKey(acc, id, index)
    const current: ToolCallAccumulator = acc.get(key) || { id, index, argumentsText: '' }
    if (id) current.id = id
    if (index !== undefined) current.index = index
    const name = pickString(block.name)
    if (name) current.name = name
    if (hasMeaningfulInput(block.input)) {
      current.input = block.input
      current.argumentsText = stringifyArguments(block.input)
    }
    acc.set(key, current)
    return
  }
  if (type === 'content_block_delta' && payload.delta?.type === 'input_json_delta') {
    const key = resolveToolCallKey(acc, '', index)
    const current: ToolCallAccumulator = acc.get(key) || { index, argumentsText: '' }
    if (index !== undefined) current.index = index
    current.input = undefined
    current.argumentsText += pickString(payload.delta.partial_json)
    acc.set(key, current)
  }
}

function hasMeaningfulInput(input: any): boolean {
  if (input === undefined || input === null) return false
  if (typeof input === 'object' && !Array.isArray(input)) return Object.keys(input).length > 0
  return true
}

function finalizeToolCalls(acc: Map<string, ToolCallAccumulator>): TraeToolCall[] {
  const out: TraeToolCall[] = []
  for (const item of [...acc.values()].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))) {
    if (!item.name) continue
    out.push({
      id: item.id,
      name: item.name,
      input: item.input ?? parseArguments(item.argumentsText)
    })
  }
  return out
}

function asArray(value: any): any[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return ''
}

function stringifyArguments(value: any): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function parseArguments(value: string): any {
  if (!value) return {}
  try {
    return JSON.parse(value)
  } catch {
    return { arguments: value }
  }
}

function stringifyContent(value: any): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item
        if (typeof item?.text === 'string') return item.text
        if (typeof item?.content === 'string') return item.content
        return ''
      })
      .filter(Boolean)
      .join('')
  }
  return ''
}

function appendDelta(current: string, chunk: string): string {
  if (!current) return chunk
  if (chunk.startsWith(current) && chunk.length > current.length) return chunk
  return current + chunk
}

function extractUsage(payload: any): UsageStats | undefined {
  if (!payload || typeof payload === 'string') return undefined
  const raw =
    payload.usage ||
    payload.token_usage ||
    payload.tokenUsage ||
    payload.data?.usage ||
    payload.data?.token_usage ||
    payload.metadata?.usage
  if (!raw || typeof raw !== 'object') return undefined
  const inputTokens = numberFrom(
    raw.input_tokens ?? raw.prompt_tokens ?? raw.inputTokens ?? raw.promptTokens
  )
  const outputTokens = numberFrom(
    raw.output_tokens ?? raw.completion_tokens ?? raw.outputTokens ?? raw.completionTokens
  )
  if (!inputTokens && !outputTokens) return undefined
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: numberFrom(raw.cache_read_tokens ?? raw.cached_tokens),
    cacheWrite5mTokens: numberFrom(raw.cache_write_5m_tokens),
    cacheWrite1hTokens: numberFrom(raw.cache_write_1h_tokens),
    credits: numberFrom(raw.credits ?? raw.fee_usage ?? raw.feeUsage),
    estimated: false
  }
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
