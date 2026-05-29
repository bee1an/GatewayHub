import { randomUUID } from 'crypto'
import type { UsageStats } from '../../types'
import { estimateTokens, sseData } from '../../core/utils'

export type UsageSink = (usage: UsageStats) => void

export async function* openAiSseFromText(
  text: string,
  model: string,
  inputBody: any,
  onUsage?: UsageSink,
  upstreamUsage?: UsageStats
): AsyncGenerator<string> {
  const id = `chatcmpl-${randomUUID().replace(/-/g, '')}`
  const created = Math.floor(Date.now() / 1000)
  yield sseData({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }]
  })
  const usage = upstreamUsage || estimatedUsage(inputBody, text)
  onUsage?.(usage)
  yield sseData({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: toOpenAiUsage(usage)
  })
  yield 'data: [DONE]\n\n'
}

export function openAiJsonFromText(
  text: string,
  model: string,
  inputBody: any,
  onUsage?: UsageSink,
  upstreamUsage?: UsageStats
): any {
  const usage = upstreamUsage || estimatedUsage(inputBody, text)
  onUsage?.(usage)
  return {
    id: `chatcmpl-${randomUUID().replace(/-/g, '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: toOpenAiUsage(usage)
  }
}

export async function* anthropicSseFromText(
  text: string,
  model: string,
  inputBody: any,
  onUsage?: UsageSink,
  upstreamUsage?: UsageStats
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
  if (text) {
    yield sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text }
    })
  }
  yield sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 })
  const usage = upstreamUsage || estimatedUsage(inputBody, text)
  onUsage?.(usage)
  yield sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: toAnthropicUsage(usage)
  })
  yield sseEvent('message_stop', { type: 'message_stop' })
}

export function anthropicJsonFromText(
  text: string,
  model: string,
  inputBody: any,
  onUsage?: UsageSink,
  upstreamUsage?: UsageStats
): any {
  const usage = upstreamUsage || estimatedUsage(inputBody, text)
  onUsage?.(usage)
  return {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: toAnthropicUsage(usage)
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
