import { randomUUID } from 'crypto'
import type { UsageStats } from '../../types'
import { sseData } from '../../core/utils'

export type UsageSink = (usage: UsageStats) => void

export class FirstTokenTimeoutError extends Error {}

/** Stream 闲置超时（每次 read() 间隔超过 streamingReadTimeoutSeconds） */
export class CodexStreamIdleTimeoutError extends Error {
  constructor(seconds: number) {
    super(`Codex stream idle timeout after ${seconds}s without data`)
    this.name = 'CodexStreamIdleTimeoutError'
  }
}

/** 上游 SSE 解析后的归一事件 */
export type CodexEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_args_delta'; id: string; args: string }
  | { type: 'tool_use_done'; id: string }
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
 * 解析 GptWeb 后端 /codex/responses 的 SSE 流。
 *
 * 关注的事件：
 * - response.output_text.delta / response.text.delta：增量文本
 * - response.reasoning_summary_text.delta / response.reasoning_text.delta：推理增量
 * - response.output_item.added (function_call)：工具调用开始
 * - response.function_call_arguments.delta：工具参数增量
 * - response.output_item.done (function_call)：工具调用完成
 * - response.completed：包含最终 usage（input_tokens / output_tokens / cached_tokens）
 * - response.error / response.failed：上游报错
 */
export async function* parseCodexStream(
  body: ReadableStream<Uint8Array>,
  firstTokenTimeoutSeconds: number,
  idleTimeoutSeconds = firstTokenTimeoutSeconds
): AsyncGenerator<CodexEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let cancelled = false

  try {
    const first = await readWithTimeout(
      reader,
      firstTokenTimeoutSeconds * 1000,
      () => new FirstTokenTimeoutError(`No Codex token within ${firstTokenTimeoutSeconds}s`)
    )
    if (first.done) return
    buffer += decoder.decode(first.value, { stream: true })
    yield* drainBuffer()

    while (true) {
      const next = await readWithTimeout(
        reader,
        idleTimeoutSeconds * 1000,
        () => new CodexStreamIdleTimeoutError(idleTimeoutSeconds)
      )
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
    try {
      await body.cancel()
    } catch {
      /* ignore */
    }
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

  // Text deltas
  if (eventName === 'response.output_text.delta' || eventName === 'response.text.delta') {
    const delta = typeof parsed?.delta === 'string' ? parsed.delta : ''
    if (!delta) return undefined
    return { type: 'text', text: delta }
  }

  // Reasoning deltas
  if (
    eventName === 'response.reasoning_summary_text.delta' ||
    eventName === 'response.reasoning_text.delta'
  ) {
    const delta = typeof parsed?.delta === 'string' ? parsed.delta : ''
    if (!delta) return undefined
    return { type: 'reasoning_delta', text: delta }
  }

  // Tool call start: response.output_item.added with function_call
  if (eventName === 'response.output_item.added') {
    const item = parsed?.item
    if (item && (item.type === 'function_call' || item.call_id)) {
      return {
        type: 'tool_use_start',
        id: item.call_id || item.id || randomUUID(),
        name: item.name || ''
      }
    }
    // Not a function_call item, silently ignore
    return undefined
  }

  // Tool call arguments delta
  if (eventName === 'response.function_call_arguments.delta') {
    const delta = typeof parsed?.delta === 'string' ? parsed.delta : ''
    const callId = parsed?.call_id || parsed?.item_id || ''
    return { type: 'tool_use_args_delta', id: callId, args: delta }
  }

  // Tool call done: response.output_item.done with function_call
  if (eventName === 'response.output_item.done') {
    const item = parsed?.item
    if (item && (item.type === 'function_call' || item.call_id)) {
      return { type: 'tool_use_done', id: item.call_id || item.id || '' }
    }
    return undefined
  }

  // Completion with usage
  if (eventName === 'response.completed') {
    const response = parsed?.response ?? parsed
    const usage = response?.usage
    return { type: 'usage', usage, model: response?.model }
  }

  // Errors
  if (
    eventName === 'response.error' ||
    eventName === 'response.failed' ||
    parsed?.type === 'error'
  ) {
    return { type: 'error', error: parsed }
  }

  // Unknown events are silently ignored
  return undefined
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
  onUsage?: UsageSink,
  idleTimeoutSeconds = firstTokenTimeoutSeconds
): AsyncGenerator<string> {
  const id = `chatcmpl-${randomUUID().replace(/-/g, '')}`
  const created = Math.floor(Date.now() / 1000)
  let first = true
  let upstreamUsage: any | undefined
  // Track tool calls for final finish_reason
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = []
  let currentToolIndex = -1

  for await (const event of parseCodexStream(body, firstTokenTimeoutSeconds, idleTimeoutSeconds)) {
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
    } else if (event.type === 'reasoning_delta') {
      yield sseData({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              ...(first ? { role: 'assistant' } : {}),
              reasoning_content: event.text
            },
            finish_reason: null
          }
        ]
      })
      first = false
    } else if (event.type === 'tool_use_start') {
      currentToolIndex += 1
      toolCalls.push({ id: event.id, name: event.name, arguments: '' })
      yield sseData({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              ...(first ? { role: 'assistant' } : {}),
              tool_calls: [
                {
                  index: currentToolIndex,
                  id: event.id,
                  type: 'function',
                  function: { name: event.name, arguments: '' }
                }
              ]
            },
            finish_reason: null
          }
        ]
      })
      first = false
    } else if (event.type === 'tool_use_args_delta') {
      const idx = toolCalls.findIndex((t) => t.id === event.id)
      const toolIdx = idx >= 0 ? idx : currentToolIndex
      if (toolIdx >= 0 && toolCalls[toolIdx]) {
        toolCalls[toolIdx].arguments += event.args
      }
      yield sseData({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: toolIdx >= 0 ? toolIdx : 0, function: { arguments: event.args } }
              ]
            },
            finish_reason: null
          }
        ]
      })
    } else if (event.type === 'tool_use_done') {
      // OpenAI SSE doesn't emit a separate "done" for tool calls; handled by finish_reason
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
    choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
    usage: toOpenAiUsage(usageStats)
  })
  yield 'data: [DONE]\n\n'
}

/** 非流式：聚合所有 text → 一个 chat.completion 响应 */
export async function openAiJsonFromCodex(
  body: ReadableStream<Uint8Array>,
  model: string,
  firstTokenTimeoutSeconds: number,
  onUsage?: UsageSink,
  idleTimeoutSeconds = firstTokenTimeoutSeconds
): Promise<any> {
  let content = ''
  let reasoning = ''
  let upstreamUsage: any | undefined
  const toolCalls: Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }> = []
  let currentTool: { id: string; name: string; arguments: string } | undefined

  for await (const event of parseCodexStream(body, firstTokenTimeoutSeconds, idleTimeoutSeconds)) {
    if (event.type === 'text') content += event.text
    else if (event.type === 'reasoning_delta') reasoning += event.text
    else if (event.type === 'tool_use_start') {
      currentTool = { id: event.id, name: event.name, arguments: '' }
    } else if (event.type === 'tool_use_args_delta') {
      if (currentTool && currentTool.id === event.id) currentTool.arguments += event.args
    } else if (event.type === 'tool_use_done') {
      if (currentTool) {
        toolCalls.push({
          id: currentTool.id,
          type: 'function',
          function: { name: currentTool.name, arguments: currentTool.arguments }
        })
        currentTool = undefined
      }
    } else if (event.type === 'usage') upstreamUsage = event.usage
    else if (event.type === 'error') throw new Error(stringifyError(event.error))
  }
  // Finalize any unclosed tool call
  if (currentTool) {
    toolCalls.push({
      id: currentTool.id,
      type: 'function',
      function: { name: currentTool.name, arguments: currentTool.arguments }
    })
  }

  const usageStats = extractUpstreamUsage(upstreamUsage) ?? {
    inputTokens: 0,
    outputTokens: 0,
    estimated: true
  }
  onUsage?.(usageStats)
  const message: any = { role: 'assistant', content }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length) message.tool_calls = toolCalls
  return {
    id: `chatcmpl-${randomUUID().replace(/-/g, '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
    usage: toOpenAiUsage(usageStats)
  }
}

/** 上游 Codex SSE → Anthropic /v1/messages SSE */
export async function* anthropicSseFromCodex(
  body: ReadableStream<Uint8Array>,
  model: string,
  firstTokenTimeoutSeconds: number,
  onUsage?: UsageSink,
  idleTimeoutSeconds = firstTokenTimeoutSeconds
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

  let index = 0
  let openBlock: 'thinking' | 'text' | 'tool_use' | undefined
  let upstreamUsage: any | undefined
  const toolCalls: string[] = [] // track tool IDs for finish_reason

  function closeOpenBlock(): string[] {
    if (!openBlock) return []
    const frames = [sseEvent('content_block_stop', { type: 'content_block_stop', index })]
    index += 1
    openBlock = undefined
    return frames
  }

  function ensureBlock(type: 'thinking' | 'text'): string[] {
    if (openBlock === type) return []
    const frames = closeOpenBlock()
    frames.push(
      sseEvent('content_block_start', {
        type: 'content_block_start',
        index,
        content_block:
          type === 'thinking'
            ? { type: 'thinking', thinking: '', signature: '' }
            : { type: 'text', text: '' }
      })
    )
    openBlock = type
    return frames
  }

  for await (const event of parseCodexStream(body, firstTokenTimeoutSeconds, idleTimeoutSeconds)) {
    if (event.type === 'text') {
      for (const frame of ensureBlock('text')) yield frame
      yield sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: event.text }
      })
    } else if (event.type === 'reasoning_delta') {
      for (const frame of ensureBlock('thinking')) yield frame
      yield sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: event.text }
      })
    } else if (event.type === 'tool_use_start') {
      for (const frame of closeOpenBlock()) yield frame
      toolCalls.push(event.id)
      yield sseEvent('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: event.id, name: event.name, input: {} }
      })
      openBlock = 'tool_use'
    } else if (event.type === 'tool_use_args_delta') {
      yield sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: event.args }
      })
    } else if (event.type === 'tool_use_done') {
      for (const frame of closeOpenBlock()) yield frame
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
  for (const frame of closeOpenBlock()) yield frame

  const usageStats = extractUpstreamUsage(upstreamUsage) ?? {
    inputTokens: 0,
    outputTokens: 0,
    estimated: true
  }
  onUsage?.(usageStats)
  yield sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: toolCalls.length ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: toAnthropicDeltaUsage(usageStats)
  })
  yield sseEvent('message_stop', { type: 'message_stop' })
}

/** 非流式 anthropic */
export async function anthropicJsonFromCodex(
  body: ReadableStream<Uint8Array>,
  model: string,
  firstTokenTimeoutSeconds: number,
  onUsage?: UsageSink,
  idleTimeoutSeconds = firstTokenTimeoutSeconds
): Promise<any> {
  let content = ''
  let thinking = ''
  let upstreamUsage: any | undefined
  const toolCalls: Array<{ id: string; name: string; input: any }> = []
  let currentTool: { id: string; name: string; arguments: string } | undefined

  for await (const event of parseCodexStream(body, firstTokenTimeoutSeconds, idleTimeoutSeconds)) {
    if (event.type === 'text') content += event.text
    else if (event.type === 'reasoning_delta') thinking += event.text
    else if (event.type === 'tool_use_start') {
      currentTool = { id: event.id, name: event.name, arguments: '' }
    } else if (event.type === 'tool_use_args_delta') {
      if (currentTool && currentTool.id === event.id) currentTool.arguments += event.args
    } else if (event.type === 'tool_use_done') {
      if (currentTool) {
        toolCalls.push({
          id: currentTool.id,
          name: currentTool.name,
          input: safeJson(currentTool.arguments)
        })
        currentTool = undefined
      }
    } else if (event.type === 'usage') upstreamUsage = event.usage
    else if (event.type === 'error') throw new Error(stringifyError(event.error))
  }
  // Finalize any unclosed tool call
  if (currentTool) {
    toolCalls.push({
      id: currentTool.id,
      name: currentTool.name,
      input: safeJson(currentTool.arguments)
    })
  }

  const usageStats = extractUpstreamUsage(upstreamUsage) ?? {
    inputTokens: 0,
    outputTokens: 0,
    estimated: true
  }
  onUsage?.(usageStats)

  const contentBlocks: any[] = []
  if (thinking) contentBlocks.push({ type: 'thinking', thinking })
  if (content) contentBlocks.push({ type: 'text', text: content })
  for (const tool of toolCalls) {
    contentBlocks.push({ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input })
  }

  return {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model,
    content: contentBlocks.length ? contentBlocks : [{ type: 'text', text: '' }],
    stop_reason: toolCalls.length ? 'tool_use' : 'end_turn',
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

function safeJson(value: any): any {
  if (!value) return {}
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}
