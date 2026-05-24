import { randomUUID } from 'crypto'
import type { UsageStats } from '../../types'
import { sseData } from '../../core/utils'

export type UsageSink = (usage: UsageStats) => void

export class FirstTokenTimeoutError extends Error {}

/** 上游 SSE 解析后的归一事件 */
export type CodexEvent =
  | { type: 'text'; text: string }
  | { type: 'usage'; usage: any; model?: string }
  | { type: 'done' }
  | { type: 'error'; error: any }

/** SSE 块边界（\n\n 或 \r\n\r\n） */
const SSE_BOUNDARY = /\r?\n\r?\n/

interface ParsedBlock {
  event?: string
  data: string
}

function parseSseBlock(block: string): ParsedBlock | undefined {
  const lines = block.split(/\r?\n/)
  let event: string | undefined
  const dataLines: string[] = []
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (!dataLines.length) return undefined
  return { event, data: dataLines.join('\n') }
}

/**
 * 解析 ChatGPT 后端 /codex/responses 的 SSE 流。
 *
 * 关注的事件：
 * - response.output_text.delta / response.text.delta：增量文本
 * - response.completed：包含最终 usage（input_tokens / output_tokens / cached_tokens）
 * - response.error：上游报错
 */
export async function* parseCodexStream(
  body: ReadableStream<Uint8Array>,
  firstTokenTimeoutSeconds: number
): AsyncGenerator<CodexEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  const first = await readWithTimeout(reader, firstTokenTimeoutSeconds * 1000)
  if (first.done) return
  buffer += decoder.decode(first.value, { stream: true })
  yield* drainBuffer()

  while (true) {
    const next = await reader.read()
    if (next.done) break
    buffer += decoder.decode(next.value, { stream: true })
    yield* drainBuffer()
  }
  if (buffer.trim()) {
    const block = parseSseBlock(buffer.trim())
    if (block) {
      const event = blockToEvent(block)
      if (event) yield event
    }
    buffer = ''
  }

  function* drainBuffer(): Generator<CodexEvent> {
    while (true) {
      const match = SSE_BOUNDARY.exec(buffer)
      if (!match) break
      const raw = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      const block = parseSseBlock(raw)
      if (!block) continue
      const event = blockToEvent(block)
      if (event) yield event
    }
  }
}

function blockToEvent(block: ParsedBlock): CodexEvent | undefined {
  if (block.data === '[DONE]') return { type: 'done' }
  let parsed: any
  try {
    parsed = JSON.parse(block.data)
  } catch {
    return undefined
  }
  const eventName = block.event || (typeof parsed?.type === 'string' ? parsed.type : '')
  if (eventName === 'response.output_text.delta' || eventName === 'response.text.delta') {
    const delta = typeof parsed?.delta === 'string' ? parsed.delta : ''
    if (!delta) return undefined
    return { type: 'text', text: delta }
  }
  if (eventName === 'response.completed') {
    const response = parsed?.response ?? parsed
    const usage = response?.usage
    return { type: 'usage', usage, model: response?.model }
  }
  if (eventName === 'response.error' || parsed?.type === 'error') {
    return { type: 'error', error: parsed }
  }
  return undefined
}

async function readWithTimeout(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
        timer = setTimeout(
          () => reject(new FirstTokenTimeoutError(`No Codex token within ${timeoutMs / 1000}s`)),
          timeoutMs
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 把上游 usage 字段（多种命名风格）归一化到 UsageStats */
export function extractUpstreamUsage(rawUsage: any): UsageStats | undefined {
  if (!rawUsage || typeof rawUsage !== 'object') return undefined
  const inputTokens = pickNumber(rawUsage, ['input_tokens', 'inputTokens', 'prompt_tokens'])
  const outputTokens = pickNumber(rawUsage, ['output_tokens', 'outputTokens', 'completion_tokens'])
  const cachedTokens = cachedTokensFromUsage(rawUsage)
  if (inputTokens === undefined && outputTokens === undefined && cachedTokens === undefined) {
    return undefined
  }
  return {
    inputTokens: Math.max(0, (inputTokens ?? 0) - (cachedTokens ?? 0)),
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cachedTokens
  }
}

function cachedTokensFromUsage(usage: any): number | undefined {
  const direct = pickNumber(usage, [
    'cached_input_tokens',
    'cache_read_input_tokens',
    'cachedInputTokens'
  ])
  if (direct !== undefined) return direct
  const inputDetails = usage.input_tokens_details ?? usage.inputTokensDetails
  const fromInput = pickNumber(inputDetails, ['cached_tokens', 'cache_read_tokens'])
  if (fromInput !== undefined) return fromInput
  const promptDetails = usage.prompt_tokens_details ?? usage.promptTokensDetails
  const fromPrompt = pickNumber(promptDetails, ['cached_tokens', 'cache_read_tokens'])
  if (fromPrompt !== undefined) return fromPrompt
  return undefined
}

function pickNumber(source: any, keys: string[]): number | undefined {
  if (!source || typeof source !== 'object') return undefined
  for (const key of keys) {
    const v = source[key]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

// ============== 出口转换器：上游 Codex SSE → 客户端期待的格式 ==============

/** 上游 Codex SSE → OpenAI Chat Completions SSE */
export async function* openAiSseFromCodex(
  body: ReadableStream<Uint8Array>,
  model: string,
  firstTokenTimeoutSeconds: number,
  onUsage?: UsageSink
): AsyncGenerator<string> {
  const id = `chatcmpl-${randomUUID().replace(/-/g, '')}`
  const created = Math.floor(Date.now() / 1000)
  let first = true
  let upstreamUsage: any | undefined

  for await (const event of parseCodexStream(body, firstTokenTimeoutSeconds)) {
    if (event.type === 'text') {
      yield sseData({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { ...(first ? { role: 'assistant' } : {}), content: event.text },
            finish_reason: null
          }
        ]
      })
      first = false
    } else if (event.type === 'usage') {
      upstreamUsage = event.usage
    } else if (event.type === 'error') {
      yield sseData({
        error: {
          message: stringifyError(event.error),
          type: 'gateway_error'
        }
      })
      yield 'data: [DONE]\n\n'
      return
    }
  }

  const usageStats = extractUpstreamUsage(upstreamUsage) ?? {
    inputTokens: 0,
    outputTokens: 0,
    estimated: true
  }
  onUsage?.(usageStats)
  yield sseData({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: toOpenAiUsage(usageStats)
  })
  yield 'data: [DONE]\n\n'
}

/** 非流式：聚合所有 text → 一个 chat.completion 响应 */
export async function openAiJsonFromCodex(
  body: ReadableStream<Uint8Array>,
  model: string,
  firstTokenTimeoutSeconds: number,
  onUsage?: UsageSink
): Promise<any> {
  let content = ''
  let upstreamUsage: any | undefined
  for await (const event of parseCodexStream(body, firstTokenTimeoutSeconds)) {
    if (event.type === 'text') content += event.text
    else if (event.type === 'usage') upstreamUsage = event.usage
    else if (event.type === 'error') throw new Error(stringifyError(event.error))
  }
  const usageStats = extractUpstreamUsage(upstreamUsage) ?? {
    inputTokens: 0,
    outputTokens: 0,
    estimated: true
  }
  onUsage?.(usageStats)
  return {
    id: `chatcmpl-${randomUUID().replace(/-/g, '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: toOpenAiUsage(usageStats)
  }
}

/** 上游 Codex SSE → Anthropic /v1/messages SSE */
export async function* anthropicSseFromCodex(
  body: ReadableStream<Uint8Array>,
  model: string,
  firstTokenTimeoutSeconds: number,
  onUsage?: UsageSink
): AsyncGenerator<string> {
  const id = `msg_${randomUUID().replace(/-/g, '')}`
  yield sseEvent('message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  })
  yield sseEvent('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' }
  })
  let upstreamUsage: any | undefined
  for await (const event of parseCodexStream(body, firstTokenTimeoutSeconds)) {
    if (event.type === 'text') {
      yield sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: event.text }
      })
    } else if (event.type === 'usage') {
      upstreamUsage = event.usage
    } else if (event.type === 'error') {
      yield sseEvent('error', {
        type: 'error',
        error: { type: 'api_error', message: stringifyError(event.error) }
      })
      return
    }
  }
  yield sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 })
  const usageStats = extractUpstreamUsage(upstreamUsage) ?? {
    inputTokens: 0,
    outputTokens: 0,
    estimated: true
  }
  onUsage?.(usageStats)
  yield sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: toAnthropicDeltaUsage(usageStats)
  })
  yield sseEvent('message_stop', { type: 'message_stop' })
}

/** 非流式 anthropic */
export async function anthropicJsonFromCodex(
  body: ReadableStream<Uint8Array>,
  model: string,
  firstTokenTimeoutSeconds: number,
  onUsage?: UsageSink
): Promise<any> {
  let content = ''
  let upstreamUsage: any | undefined
  for await (const event of parseCodexStream(body, firstTokenTimeoutSeconds)) {
    if (event.type === 'text') content += event.text
    else if (event.type === 'usage') upstreamUsage = event.usage
    else if (event.type === 'error') throw new Error(stringifyError(event.error))
  }
  const usageStats = extractUpstreamUsage(upstreamUsage) ?? {
    inputTokens: 0,
    outputTokens: 0,
    estimated: true
  }
  onUsage?.(usageStats)
  return {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: content }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: toAnthropicDeltaUsage(usageStats)
  }
}

function sseEvent(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function toOpenAiUsage(usage: UsageStats): any {
  const cached = usage.cacheReadTokens ?? 0
  const prompt_tokens = (usage.inputTokens || 0) + cached
  const completion_tokens = usage.outputTokens || 0
  const result: any = {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens
  }
  if (cached > 0) result.prompt_tokens_details = { cached_tokens: cached }
  return result
}

function toAnthropicDeltaUsage(usage: UsageStats): any {
  const out: any = { input_tokens: usage.inputTokens || 0, output_tokens: usage.outputTokens || 0 }
  if (usage.cacheReadTokens !== undefined) out.cache_read_input_tokens = usage.cacheReadTokens
  return out
}

function stringifyError(error: any): string {
  if (!error) return 'Codex stream error'
  if (typeof error === 'string') return error
  if (error.error?.message) return String(error.error.message)
  if (error.message) return String(error.message)
  try {
    return JSON.stringify(error).slice(0, 500)
  } catch {
    return 'Codex stream error'
  }
}
