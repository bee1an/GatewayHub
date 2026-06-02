import { randomUUID } from 'crypto'
import type { GrokGatewayEvent } from './types'

interface OpenAIMessage {
  role: string
  content:
    | string
    | Array<{
        type?: string
        text?: string
        input_text?: string
        [key: string]: unknown
      }>
}

export interface GrokStreamingState {
  responseId: string
  itemId: string
  model: string
  content: string
  finished: boolean
}

const IGNORED_MESSAGE_TAGS = new Set([
  'summary',
  'header',
  'tool_partial_output',
  'tool_usage_card'
])

export function convertOpenAIToGrokPrompt(messages: OpenAIMessage[]): string {
  const normalized = messages
    .map((message) => {
      const text = extractText(message.content).trim()
      if (!text) return ''
      const role =
        message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user'
      return role === 'user' ? text : `[${role}]\n${text}`
    })
    .filter(Boolean)
  return normalized.join('\n\n') || 'Hello'
}

export function parseGrokGatewayEvent(
  event: GrokGatewayEvent,
  state: GrokStreamingState
): { chunk: string | null; done: boolean } {
  switch (event.type) {
    case 'response.created': {
      const id = event.response?.id || event.response_id
      if (id) state.responseId = id
      return { chunk: null, done: false }
    }
    case 'response.output_item.added': {
      const id = event.item?.id
      if (id) state.itemId = id
      return { chunk: null, done: false }
    }
    case 'response.output_text.delta': {
      const delta = typeof event.delta === 'string' ? event.delta : ''
      if (!delta || shouldIgnoreDelta(event)) return { chunk: null, done: false }
      state.content += delta
      return { chunk: buildOpenAIChunk(state, delta, null), done: false }
    }
    case 'response.done': {
      const id = event.response?.id || event.response_id
      if (id) state.responseId = id
      state.finished = true
      return { chunk: buildOpenAIChunk(state, '', 'stop'), done: true }
    }
    case 'error': {
      const message = event.error?.message || 'Grok Web returned an error'
      throw new Error(message)
    }
    default:
      return { chunk: null, done: false }
  }
}

export function createStreamingState(model = 'auto'): GrokStreamingState {
  return { responseId: '', itemId: '', model, content: '', finished: false }
}

function shouldIgnoreDelta(event: GrokGatewayEvent): boolean {
  if (event.x_grok?.is_thinking) return true
  const tag = event.x_grok?.message_tag
  return Boolean(tag && IGNORED_MESSAGE_TAGS.has(tag))
}

function extractText(content: OpenAIMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (part.type && part.type !== 'text' && part.type !== 'input_text') return ''
      return part.text || part.input_text || ''
    })
    .filter(Boolean)
    .join('\n')
}

function buildOpenAIChunk(
  state: GrokStreamingState,
  content: string,
  finishReason: string | null
): string {
  const chunk = {
    id: `chatcmpl-${state.responseId || state.itemId || randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: state.model || 'auto',
    choices: [
      {
        index: 0,
        delta: content ? { content } : {},
        finish_reason: finishReason
      }
    ]
  }
  return `data: ${JSON.stringify(chunk)}\n\n`
}
