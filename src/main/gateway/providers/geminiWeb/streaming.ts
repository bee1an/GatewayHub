import { randomUUID } from 'crypto'
import type { GeminiStreamEvent } from './types'

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

export interface GeminiStreamingState {
  responseId: string
  model: string
  content: string
  finished: boolean
}

/**
 * Flattens OpenAI-style messages into a single prompt string for Gemini's web
 * batchexecute flow (which takes one user-turn blob, not a role-structured
 * array). System/assistant turns are prefixed with a role tag so the model can
 * still distinguish them.
 */
export function convertOpenAIToGeminiPrompt(messages: OpenAIMessage[]): string {
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

/**
 * Maps a normalized Gemini stream event into an OpenAI-format SSE chunk (or a
 * terminal stop chunk). Mirrors grokWeb's parseGrokGatewayEvent contract so the
 * provider's failover loop is identical.
 *
 * IMPORTANT: each `text` event carries the *cumulative* response seen so far
 * (Gemini's StreamGenerate emits the running full text on every frame, not
 * incremental deltas). We compute the actual delta against `state.content`
 * here so downstream consumers receive proper OpenAI-style increments.
 */
export function parseGeminiBatchEvent(
  event: GeminiStreamEvent,
  state: GeminiStreamingState
): { chunk: string | null; done: boolean } {
  switch (event.type) {
    case 'text': {
      const incoming = event.delta
      if (!incoming) return { chunk: null, done: false }
      // Compute the prefix-delta against what we've already streamed. If the
      // upstream replaced (rather than extended) the text — rare but possible
      // when a candidate is rewritten mid-stream — treat the new value as a
      // full replacement and only emit the trailing portion that wasn't seen.
      let delta = ''
      if (incoming.startsWith(state.content)) {
        delta = incoming.slice(state.content.length)
      } else {
        delta = incoming
      }
      state.content = incoming
      if (!delta) return { chunk: null, done: false }
      return { chunk: buildOpenAIChunk(state, delta, null), done: false }
    }
    case 'done': {
      state.finished = true
      return { chunk: buildOpenAIChunk(state, '', 'stop'), done: true }
    }
    case 'error': {
      throw new Error(event.message || 'Gemini Web returned an error')
    }
    default:
      return { chunk: null, done: false }
  }
}

export function createStreamingState(model = 'gemini-3.5-flash'): GeminiStreamingState {
  return { responseId: '', model, content: '', finished: false }
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
  state: GeminiStreamingState,
  content: string,
  finishReason: string | null
): string {
  const chunk = {
    id: `chatcmpl-${state.responseId || randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: state.model || 'gemini-3.5-flash',
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
