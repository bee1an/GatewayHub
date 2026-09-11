import { randomUUID } from 'crypto'
import type { UsageStats } from '../../types'
import { estimateTokens, sseData } from '../../core/utils'
import type { TraeWorkChatResult, TraeWorkStreamEvent, TraeWorkToolCall } from './rawChat'

export type UsageSink = (usage: UsageStats) => void

/**
 * Maps the upstream llm_utils_chat event stream to OpenAI
 * chat.completion.chunk SSE. `output` events carry incremental
 * response/reasoning_content/tool_calls deltas; `token_usage` and `done`
 * arrive at the end.
 */
export async function* openAiSseFromEvents(
  events: AsyncIterable<TraeWorkStreamEvent>,
  model: string,
  inputBody: any,
  onUsage?: UsageSink
): AsyncGenerator<string> {
  const id = `chatcmpl-${randomUUID().replace(/-/g, '')}`
  const created = Math.floor(Date.now() / 1000)
  const chunk = (delta: any, finishReason: string | null, usage?: any) =>
    sseData({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage ? { usage } : {})
    })

  yield chunk({ role: 'assistant' }, null)
  let usage: UsageStats | undefined
  let finishReason = 'stop'
  let sawToolCalls = false
  let text = ''
  for await (const item of events) {
    const payload = item.data
    if (item.event === 'output' && payload && typeof payload === 'object') {
      const delta: any = {}
      const content = pickText(payload.response)
      if (content) {
        delta.content = content
        text += content
      }
      const reasoning = pickText(payload.reasoning_content)
      if (reasoning) delta.reasoning_content = reasoning
      const toolCalls = toOpenAiToolCallDeltas(payload.tool_calls)
      if (toolCalls?.length) {
        delta.tool_calls = toolCalls
        sawToolCalls = true
      }
      if (Object.keys(delta).length) yield chunk(delta, null)
      continue
    }
    if (item.event === 'token_usage') {
      usage = extractUsageStats(payload) ?? usage
      continue
    }
    if (item.event === 'done') {
      finishReason = pickString(payload?.finish_reason) || finishReason
      continue
    }
    if (item.event === 'error') {
      throw new Error(formatUpstreamError(payload))
    }
  }
  const finalUsage = usage || estimatedUsage(inputBody, text)
  onUsage?.(finalUsage)
  yield chunk({}, sawToolCalls ? 'tool_calls' : finishReason, toOpenAiUsage(finalUsage))
  yield 'data: [DONE]\n\n'
}

/**
 * Maps upstream events to Anthropic Messages SSE. reasoning_content is emitted
 * as a thinking block, response text as a text block, and tool calls as
 * tool_use blocks with input_json_delta chunks.
 */
export async function* anthropicSseFromEvents(
  events: AsyncIterable<TraeWorkStreamEvent>,
  model: string,
  inputBody: any,
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

  let usage: UsageStats | undefined
  let finishReason = 'end_turn'
  let blockIndex = -1
  let openKind: 'thinking' | 'text' | 'tool' | null = null
  const openToolBlocks = new Map<number, number>()
  let text = ''

  const closeOpenBlock = function* (): Generator<string> {
    if (openKind === null) return
    yield sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })
    openKind = null
  }

  for await (const item of events) {
    const payload = item.data
    if (item.event === 'output' && payload && typeof payload === 'object') {
      const reasoning = pickText(payload.reasoning_content)
      if (reasoning) {
        if (openKind !== 'thinking') {
          yield* closeOpenBlock()
          blockIndex += 1
          openKind = 'thinking'
          yield sseEvent('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'thinking', thinking: '', signature: '' }
          })
        }
        yield sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'thinking_delta', thinking: reasoning }
        })
      }
      const content = pickText(payload.response)
      if (content) {
        if (openKind !== 'text') {
          yield* closeOpenBlock()
          blockIndex += 1
          openKind = 'text'
          yield sseEvent('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' }
          })
        }
        text += content
        yield sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'text_delta', text: content }
        })
      }
      for (const call of asArray(payload.tool_calls)) {
        if (!call || typeof call !== 'object') continue
        const upstreamIndex = typeof call.index === 'number' ? call.index : 0
        const name = pickString(call.function_call?.name, call.function?.name, call.name)
        const args = call.function_call?.arguments ?? call.function?.arguments ?? call.arguments
        let assigned = openToolBlocks.get(upstreamIndex)
        if (assigned === undefined) {
          yield* closeOpenBlock()
          blockIndex += 1
          assigned = blockIndex
          openToolBlocks.set(upstreamIndex, assigned)
          yield sseEvent('content_block_start', {
            type: 'content_block_start',
            index: assigned,
            content_block: {
              type: 'tool_use',
              id: pickString(call.id) || `toolu_${randomUUID().replace(/-/g, '')}`,
              name: name || 'unknown',
              input: {}
            }
          })
        }
        if (args !== undefined && args !== null) {
          const argText = typeof args === 'string' ? args : JSON.stringify(args)
          if (argText) {
            yield sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: assigned,
              delta: { type: 'input_json_delta', partial_json: argText }
            })
          }
        }
      }
      continue
    }
    if (item.event === 'token_usage') {
      usage = extractUsageStats(payload) ?? usage
      continue
    }
    if (item.event === 'done') {
      const upstream = pickString(payload?.finish_reason)
      finishReason = upstream === 'stop' || !upstream ? 'end_turn' : upstream
      continue
    }
    if (item.event === 'error') {
      throw new Error(formatUpstreamError(payload))
    }
  }

  yield* closeOpenBlock()
  const finalUsage = usage || estimatedUsage(inputBody, text)
  onUsage?.(finalUsage)
  yield sseEvent('message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: openToolBlocks.size ? 'tool_use' : finishReason,
      stop_sequence: null
    },
    usage: toAnthropicUsage(finalUsage)
  })
  yield sseEvent('message_stop', { type: 'message_stop' })
}

export function openAiJsonFromResult(
  result: TraeWorkChatResult,
  model: string,
  inputBody: any,
  onUsage?: UsageSink
): any {
  const usage = result.usage || estimatedUsage(inputBody, result.text)
  onUsage?.(usage)
  const hasToolCalls = Boolean(result.toolCalls?.length)
  const message: any = {
    role: 'assistant',
    content: result.text || (hasToolCalls ? null : '')
  }
  if (result.reasoning) message.reasoning_content = result.reasoning
  if (hasToolCalls) message.tool_calls = toOpenAiToolCalls(result.toolCalls!)
  return {
    id: `chatcmpl-${randomUUID().replace(/-/g, '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: hasToolCalls ? 'tool_calls' : result.finishReason || 'stop'
      }
    ],
    usage: toOpenAiUsage(usage)
  }
}

export function anthropicJsonFromResult(
  result: TraeWorkChatResult,
  model: string,
  inputBody: any,
  onUsage?: UsageSink
): any {
  const usage = result.usage || estimatedUsage(inputBody, result.text)
  onUsage?.(usage)
  const content: any[] = []
  if (result.reasoning) {
    content.push({ type: 'thinking', thinking: result.reasoning, signature: '' })
  }
  if (result.text) content.push({ type: 'text', text: result.text })
  for (const toolCall of result.toolCalls || []) {
    content.push({
      type: 'tool_use',
      id: toolCall.id || `toolu_${randomUUID().replace(/-/g, '')}`,
      name: toolCall.name,
      input: normalizeToolInput(toolCall.input)
    })
  }
  if (!content.length) content.push({ type: 'text', text: '' })
  return {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: result.toolCalls?.length ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: toAnthropicUsage(usage)
  }
}

function toOpenAiToolCallDeltas(value: any): any[] | undefined {
  const items = asArray(value)
  if (!items.length) return undefined
  const out: any[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item || typeof item !== 'object') continue
    const index = typeof item.index === 'number' ? item.index : i
    const name = pickString(item.function_call?.name, item.function?.name, item.name)
    const args = item.function_call?.arguments ?? item.function?.arguments ?? item.arguments
    const entry: any = { index, type: 'function' }
    const id = pickString(item.id, item.tool_call_id)
    if (id) entry.id = id
    entry.function = {}
    if (name) entry.function.name = name
    if (args !== undefined && args !== null) {
      entry.function.arguments = typeof args === 'string' ? args : JSON.stringify(args)
    }
    out.push(entry)
  }
  return out.length ? out : undefined
}

function toOpenAiToolCalls(toolCalls: TraeWorkToolCall[]): any[] {
  return toolCalls.map((toolCall, index) => ({
    index,
    id: toolCall.id || `call_${randomUUID().replace(/-/g, '')}`,
    type: 'function',
    function: {
      name: toolCall.name,
      arguments:
        toolCall.argumentsText ??
        (typeof toolCall.input === 'string' ? toolCall.input : JSON.stringify(toolCall.input ?? {}))
    }
  }))
}

function extractUsageStats(payload: any): UsageStats | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const inputTokens = numberFrom(payload.prompt_tokens ?? payload.input_tokens)
  const outputTokens = numberFrom(payload.completion_tokens ?? payload.output_tokens)
  if (!inputTokens && !outputTokens) return undefined
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: numberFrom(payload.cache_read_input_tokens),
    cacheWrite5mTokens: numberFrom(payload.cache_creation_input_tokens),
    estimated: false
  }
}

function estimatedUsage(inputBody: any, output: string): UsageStats {
  return {
    inputTokens: estimateTokens(inputBody),
    outputTokens: estimateTokens(output),
    estimated: true
  }
}

function toOpenAiUsage(usage: UsageStats): any {
  const prompt_tokens = usage.inputTokens || 0
  const completion_tokens = usage.outputTokens || 0
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens }
}

function toAnthropicUsage(usage: UsageStats): any {
  return { input_tokens: usage.inputTokens || 0, output_tokens: usage.outputTokens || 0 }
}

function normalizeToolInput(input: any): any {
  if (!input) return {}
  if (typeof input === 'object') return input
  if (typeof input === 'string') {
    try {
      return JSON.parse(input)
    } catch {
      return { arguments: input }
    }
  }
  return { value: input }
}

function formatUpstreamError(payload: any): string {
  if (payload && typeof payload === 'object') {
    const code = payload.code ?? payload.error?.code
    const message = payload.message || payload.error?.message || payload.error || ''
    return `TraeWork upstream error${code !== undefined ? ` ${code}` : ''}: ${message}`
  }
  return `TraeWork upstream error: ${String(payload)}`
}

function sseEvent(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
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
