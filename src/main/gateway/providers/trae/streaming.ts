import { randomUUID } from 'crypto'
import type { UsageStats } from '../../types'
import { estimateTokens, sseData } from '../../core/utils'

export type UsageSink = (usage: UsageStats) => void

export interface GatewayToolCall {
  id?: string
  name: string
  input: any
}

export async function* openAiSseFromText(
  text: string,
  model: string,
  inputBody: any,
  onUsage?: UsageSink,
  upstreamUsage?: UsageStats,
  toolCalls?: GatewayToolCall[]
): AsyncGenerator<string> {
  const id = `chatcmpl-${randomUUID().replace(/-/g, '')}`
  const created = Math.floor(Date.now() / 1000)
  const hasToolCalls = Boolean(toolCalls?.length)
  const firstDelta: any = { role: 'assistant' }
  if (text) firstDelta.content = text
  if (hasToolCalls) firstDelta.tool_calls = toOpenAiToolCalls(toolCalls!)
  yield sseData({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: firstDelta, finish_reason: null }]
  })
  const usage = upstreamUsage || estimatedUsage(inputBody, text)
  onUsage?.(usage)
  yield sseData({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: hasToolCalls ? 'tool_calls' : 'stop' }],
    usage: toOpenAiUsage(usage)
  })
  yield 'data: [DONE]\n\n'
}

export function openAiJsonFromText(
  text: string,
  model: string,
  inputBody: any,
  onUsage?: UsageSink,
  upstreamUsage?: UsageStats,
  toolCalls?: GatewayToolCall[]
): any {
  const usage = upstreamUsage || estimatedUsage(inputBody, text)
  onUsage?.(usage)
  const hasToolCalls = Boolean(toolCalls?.length)
  const message: any = { role: 'assistant', content: text || (hasToolCalls ? null : '') }
  if (hasToolCalls) message.tool_calls = toOpenAiToolCalls(toolCalls!)
  return {
    id: `chatcmpl-${randomUUID().replace(/-/g, '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: hasToolCalls ? 'tool_calls' : 'stop' }],
    usage: toOpenAiUsage(usage)
  }
}

export async function* anthropicSseFromText(
  text: string,
  model: string,
  inputBody: any,
  onUsage?: UsageSink,
  upstreamUsage?: UsageStats,
  toolCalls?: GatewayToolCall[]
): AsyncGenerator<string> {
  const id = `msg_${randomUUID().replace(/-/g, '')}`
  const blocks = toAnthropicContentBlocks(text, toolCalls)
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
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    yield sseEvent('content_block_start', {
      type: 'content_block_start',
      index: i,
      content_block:
        block.type === 'tool_use'
          ? { type: 'tool_use', id: block.id, name: block.name, input: {} }
          : { type: 'text', text: '' }
    })
    if (block.type === 'text' && block.text) {
      yield sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: i,
        delta: { type: 'text_delta', text: block.text }
      })
    } else if (block.type === 'tool_use') {
      yield sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: i,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) }
      })
    }
    yield sseEvent('content_block_stop', { type: 'content_block_stop', index: i })
  }
  const usage = upstreamUsage || estimatedUsage(inputBody, text)
  onUsage?.(usage)
  yield sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: toolCalls?.length ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: toAnthropicUsage(usage)
  })
  yield sseEvent('message_stop', { type: 'message_stop' })
}

export function anthropicJsonFromText(
  text: string,
  model: string,
  inputBody: any,
  onUsage?: UsageSink,
  upstreamUsage?: UsageStats,
  toolCalls?: GatewayToolCall[]
): any {
  const usage = upstreamUsage || estimatedUsage(inputBody, text)
  onUsage?.(usage)
  return {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model,
    content: toAnthropicContentBlocks(text, toolCalls),
    stop_reason: toolCalls?.length ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: toAnthropicUsage(usage)
  }
}

function toOpenAiToolCalls(toolCalls: GatewayToolCall[]): any[] {
  return toolCalls.map((toolCall, index) => ({
    index,
    id: toolCall.id || `call_${randomUUID().replace(/-/g, '')}`,
    type: 'function',
    function: {
      name: toolCall.name,
      arguments: stringifyToolInput(toolCall.input)
    }
  }))
}

function toAnthropicContentBlocks(text: string, toolCalls?: GatewayToolCall[]): any[] {
  const blocks: any[] = []
  if (text) blocks.push({ type: 'text', text })
  for (const toolCall of toolCalls || []) {
    blocks.push({
      type: 'tool_use',
      id: toolCall.id || `toolu_${randomUUID().replace(/-/g, '')}`,
      name: toolCall.name,
      input: normalizeToolInput(toolCall.input)
    })
  }
  if (!blocks.length) blocks.push({ type: 'text', text: '' })
  return blocks
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

function stringifyToolInput(input: any): string {
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(normalizeToolInput(input))
  } catch {
    return '{}'
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

function sseEvent(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}
