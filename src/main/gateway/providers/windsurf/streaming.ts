import { randomUUID } from 'crypto'
import type { UsageStats } from '../../types'
import { estimateTokens, sseData } from '../../core/utils'
import type { WindsurfCascadeStreamEvent } from './cascade'
import {
  splitInlineToolCalls,
  stringifyToolInput,
  toAnthropicContentBlocks,
  toOpenAiToolCalls,
  type GatewayToolCall
} from './toolCalls'

export type UsageSink = (usage: UsageStats) => void

export async function* openAiSseFromText(
  text: string,
  model: string,
  inputBody: any,
  onUsage?: UsageSink,
  upstreamUsage?: UsageStats,
  upstreamToolCalls?: GatewayToolCall[]
): AsyncGenerator<string> {
  const id = `chatcmpl-${randomUUID().replace(/-/g, '')}`
  const created = Math.floor(Date.now() / 1000)
  const parsed = splitInlineToolCalls(text)
  const toolCalls = mergeToolCalls(upstreamToolCalls, parsed.toolCalls)
  const finalText = parsed.text
  const hasToolCalls = Boolean(toolCalls.length)
  const firstDelta: any = { role: 'assistant' }
  if (finalText) firstDelta.content = finalText
  if (hasToolCalls) firstDelta.tool_calls = toOpenAiToolCalls(toolCalls)
  yield sseData({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: firstDelta, finish_reason: null }]
  })
  const usage = upstreamUsage || estimatedUsage(inputBody, finalText)
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

export async function* openAiSseFromCascadeDeltas(
  source: AsyncIterable<WindsurfCascadeStreamEvent>,
  model: string,
  inputBody: any,
  onUsage?: UsageSink
): AsyncGenerator<string> {
  const id = `chatcmpl-${randomUUID().replace(/-/g, '')}`
  const created = Math.floor(Date.now() / 1000)
  let started = false
  let emittedText = ''
  let usage: UsageStats | undefined
  let toolCalls: GatewayToolCall[] = []
  for await (const event of source) {
    if (event.usage) usage = event.usage
    if (event.toolCalls?.length) toolCalls = mergeToolCalls(toolCalls, event.toolCalls)
    const finalText = event.text || ''
    let delta = event.textDelta || ''
    if (!delta && event.done && finalText.startsWith(emittedText)) {
      delta = finalText.slice(emittedText.length)
    }
    if (delta) {
      emittedText += delta
      const payloadDelta: any = started ? { content: delta } : { role: 'assistant', content: delta }
      started = true
      yield sseData({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: payloadDelta, finish_reason: null }]
      })
    }
    if (event.done) break
  }
  if (!started && !toolCalls.length) {
    started = true
    yield sseData({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
    })
  }
  if (toolCalls.length) {
    if (!started) {
      yield sseData({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
      })
      started = true
    }
    for (const [index, toolCall] of toolCalls.entries()) {
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
                {
                  index,
                  id: toolCall.id || `call_${randomUUID().replace(/-/g, '')}`,
                  type: 'function',
                  function: { name: toolCall.name, arguments: stringifyToolInput(toolCall.input) }
                }
              ]
            },
            finish_reason: null
          }
        ]
      })
    }
  }
  const finalUsage = usage || estimatedUsage(inputBody, emittedText)
  onUsage?.(finalUsage)
  yield sseData({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
    usage: toOpenAiUsage(finalUsage)
  })
  yield 'data: [DONE]\n\n'
}

export function openAiJsonFromText(
  text: string,
  model: string,
  inputBody: any,
  onUsage?: UsageSink,
  upstreamUsage?: UsageStats,
  upstreamToolCalls?: GatewayToolCall[]
): any {
  const parsed = splitInlineToolCalls(text)
  const toolCalls = mergeToolCalls(upstreamToolCalls, parsed.toolCalls)
  const finalText = parsed.text
  const hasToolCalls = Boolean(toolCalls.length)
  const usage = upstreamUsage || estimatedUsage(inputBody, finalText)
  onUsage?.(usage)
  const message: any = { role: 'assistant', content: finalText || (hasToolCalls ? null : '') }
  if (hasToolCalls) message.tool_calls = toOpenAiToolCalls(toolCalls)
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
  upstreamToolCalls?: GatewayToolCall[]
): AsyncGenerator<string> {
  const id = `msg_${randomUUID().replace(/-/g, '')}`
  const parsed = splitInlineToolCalls(text)
  const toolCalls = mergeToolCalls(upstreamToolCalls, parsed.toolCalls)
  const blocks = toAnthropicContentBlocks(parsed.text, toolCalls)
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
  const usage = upstreamUsage || estimatedUsage(inputBody, parsed.text)
  onUsage?.(usage)
  yield sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: toolCalls.length ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: toAnthropicUsage(usage)
  })
  yield sseEvent('message_stop', { type: 'message_stop' })
}

export async function* anthropicSseFromCascadeDeltas(
  source: AsyncIterable<WindsurfCascadeStreamEvent>,
  model: string,
  inputBody: any,
  onUsage?: UsageSink
): AsyncGenerator<string> {
  const id = `msg_${randomUUID().replace(/-/g, '')}`
  let messageStarted = false
  let textBlockOpen = false
  let emittedText = ''
  let usage: UsageStats | undefined
  let toolCalls: GatewayToolCall[] = []
  let blockIndex = 0
  const ensureMessageStarted = function* (): Generator<string> {
    if (messageStarted) return
    messageStarted = true
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
  }
  for await (const event of source) {
    if (event.usage) usage = event.usage
    if (event.toolCalls?.length) toolCalls = mergeToolCalls(toolCalls, event.toolCalls)
    const finalText = event.text || ''
    let delta = event.textDelta || ''
    if (!delta && event.done && finalText.startsWith(emittedText)) {
      delta = finalText.slice(emittedText.length)
    }
    if (delta) {
      if (!textBlockOpen) {
        yield* ensureMessageStarted()
        yield sseEvent('content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'text', text: '' }
        })
        textBlockOpen = true
      }
      emittedText += delta
      yield sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'text_delta', text: delta }
      })
    }
    if (event.done) break
  }
  if (textBlockOpen) {
    yield sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })
    blockIndex += 1
  }
  yield* ensureMessageStarted()
  if (!textBlockOpen && !toolCalls.length) {
    yield sseEvent('content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'text', text: '' }
    })
    yield sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })
    blockIndex += 1
  }
  for (const toolCall of toolCalls) {
    yield sseEvent('content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: {
        type: 'tool_use',
        id: toolCall.id || `toolu_${randomUUID().replace(/-/g, '')}`,
        name: toolCall.name,
        input: {}
      }
    })
    yield sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'input_json_delta', partial_json: stringifyToolInput(toolCall.input) }
    })
    yield sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })
    blockIndex += 1
  }
  const finalUsage = usage || estimatedUsage(inputBody, emittedText)
  onUsage?.(finalUsage)
  yield sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: toolCalls.length ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: toAnthropicUsage(finalUsage)
  })
  yield sseEvent('message_stop', { type: 'message_stop' })
}

export function anthropicJsonFromText(
  text: string,
  model: string,
  inputBody: any,
  onUsage?: UsageSink,
  upstreamUsage?: UsageStats,
  upstreamToolCalls?: GatewayToolCall[]
): any {
  const parsed = splitInlineToolCalls(text)
  const toolCalls = mergeToolCalls(upstreamToolCalls, parsed.toolCalls)
  const usage = upstreamUsage || estimatedUsage(inputBody, parsed.text)
  onUsage?.(usage)
  return {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model,
    content: toAnthropicContentBlocks(parsed.text, toolCalls),
    stop_reason: toolCalls.length ? 'tool_use' : 'end_turn',
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
  const cached = usage.cacheReadTokens ?? 0
  const cacheWrite = (usage.cacheWrite5mTokens ?? 0) + (usage.cacheWrite1hTokens ?? 0)
  const prompt_tokens = (usage.inputTokens || 0) + cached + cacheWrite
  const completion_tokens = usage.outputTokens || 0
  const result: any = {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens
  }
  if (cached > 0) result.prompt_tokens_details = { cached_tokens: cached }
  return result
}

function toAnthropicUsage(usage: UsageStats): any {
  const out: any = { input_tokens: usage.inputTokens || 0, output_tokens: usage.outputTokens || 0 }
  if (usage.cacheReadTokens !== undefined) out.cache_read_input_tokens = usage.cacheReadTokens
  const cacheWrite = (usage.cacheWrite5mTokens ?? 0) + (usage.cacheWrite1hTokens ?? 0)
  if (cacheWrite > 0) out.cache_creation_input_tokens = cacheWrite
  return out
}

function sseEvent(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function mergeToolCalls(first?: GatewayToolCall[], second?: GatewayToolCall[]): GatewayToolCall[] {
  const seen = new Set<string>()
  const result: GatewayToolCall[] = []
  for (const toolCall of [...(first || []), ...(second || [])]) {
    const key = `${toolCall.id || ''}\0${toolCall.name}\0${stringifyToolInput(toolCall.input)}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(toolCall)
  }
  return result
}
