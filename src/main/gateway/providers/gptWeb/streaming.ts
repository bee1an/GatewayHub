import { randomUUID } from 'crypto'

interface OpenAIMessage {
  role: string
  content: string | Array<{ type: string; text?: string }>
}

interface GptWebDelta {
  p?: string
  o?: string
  v: unknown
  c?: number
}

export function convertOpenAIToGptWebBody(
  messages: OpenAIMessage[],
  model: string
): {
  action: string
  messages: Array<{
    id: string
    author: { role: string }
    content: { content_type: string; parts: string[] }
    metadata: Record<string, unknown>
  }>
  model: string
  conversation_mode: { kind: string }
  enable_message_followups: boolean
  system_hints: string[]
  supports_buffering: boolean
  supported_encodings: string[]
  timezone_offset_min: number
  timezone: string
  client_contextual_info: Record<string, unknown>
  paragen_cot_summary_display_override: string
  force_parallel_switch: string
} {
  const converted = messages.map((msg) => {
    const text =
      typeof msg.content === 'string'
        ? msg.content
        : msg.content
            .filter((p) => p.type === 'text')
            .map((p) => p.text || '')
            .join('\n')

    return {
      id: randomUUID(),
      author: {
        role: msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user'
      },
      content: { content_type: 'text', parts: [text] },
      metadata: {
        serialization_metadata: { custom_symbol_offsets: [] }
      }
    }
  })

  return {
    action: 'next',
    messages: converted,
    model: model || 'auto',
    conversation_mode: { kind: 'primary_assistant' },
    enable_message_followups: true,
    system_hints: [],
    supports_buffering: true,
    supported_encodings: ['v1'],
    timezone_offset_min: new Date().getTimezoneOffset(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    client_contextual_info: {
      is_dark_mode: false,
      time_since_loaded: 120,
      page_height: 924,
      page_width: 1200,
      pixel_ratio: 1,
      screen_height: 1080,
      screen_width: 1920,
      app_name: 'chatgpt.com'
    },
    paragen_cot_summary_display_override: 'allow',
    force_parallel_switch: 'auto'
  }
}

export interface StreamingState {
  messageId: string
  model: string
  content: string
  finished: boolean
}

export function parseGptWebSSE(
  line: string,
  state: StreamingState
): { chunk: string | null; done: boolean } {
  if (line === 'data: [DONE]') {
    return { chunk: buildOpenAIChunk(state, '', 'stop'), done: true }
  }

  if (line.startsWith('event: delta_encoding')) {
    return { chunk: null, done: false }
  }

  if (!line.startsWith('data: ')) {
    return { chunk: null, done: false }
  }

  const jsonStr = line.slice(6)
  let data: unknown
  try {
    data = JSON.parse(jsonStr)
  } catch {
    return { chunk: null, done: false }
  }

  if (typeof data !== 'object' || data === null) {
    return { chunk: null, done: false }
  }

  const obj = data as Record<string, unknown>

  if (obj.type === 'message_stream_complete') {
    return { chunk: null, done: false }
  }

  if ('p' in obj || 'o' in obj || 'v' in obj || 'c' in obj) {
    return handleDelta(obj as unknown as GptWebDelta, state)
  }

  if (obj.type === 'input_message') {
    return { chunk: null, done: false }
  }

  return { chunk: null, done: false }
}

function handleDelta(
  delta: GptWebDelta,
  state: StreamingState
): { chunk: string | null; done: boolean } {
  captureMessageMetadata(delta.v, state)

  if (delta.o === 'add' && delta.v && typeof delta.v === 'object') {
    return { chunk: null, done: false }
  }

  if (delta.o === 'append' && delta.p?.includes('/content/parts/')) {
    const text = delta.v as string
    if (text) {
      state.content += text
      return { chunk: buildOpenAIChunk(state, text, null), done: false }
    }
  }

  if (!delta.o && !delta.p && typeof delta.v === 'string') {
    state.content += delta.v
    return { chunk: buildOpenAIChunk(state, delta.v, null), done: false }
  }

  if (delta.o === 'patch' && Array.isArray(delta.v)) {
    let text = ''
    for (const patch of delta.v as Array<Record<string, unknown>>) {
      if (patch.o === 'append' && (patch.p as string)?.includes('/content/parts/')) {
        text += patch.v as string
      }
      if (
        patch.o === 'replace' &&
        patch.p === '/message/status' &&
        patch.v === 'finished_successfully'
      ) {
        state.finished = true
      }
    }
    if (text) {
      state.content += text
      return { chunk: buildOpenAIChunk(state, text, state.finished ? 'stop' : null), done: false }
    }
    if (state.finished) {
      return { chunk: buildOpenAIChunk(state, '', 'stop'), done: false }
    }
  }

  return { chunk: null, done: false }
}

function captureMessageMetadata(value: unknown, state: StreamingState): void {
  if (!value || typeof value !== 'object') return
  const msg = (value as Record<string, unknown>).message as Record<string, unknown> | undefined
  if (!msg) return
  if (msg.id) state.messageId = msg.id as string
  const meta = msg.metadata as Record<string, unknown> | undefined
  if (meta?.resolved_model_slug) state.model = meta.resolved_model_slug as string
  if (meta?.model_slug) state.model = meta.model_slug as string
}

function buildOpenAIChunk(
  state: StreamingState,
  content: string,
  finishReason: string | null
): string {
  const chunk = {
    id: `chatcmpl-${state.messageId || randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: state.model || 'gpt-4o',
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

export function createStreamingState(): StreamingState {
  return { messageId: '', model: '', content: '', finished: false }
}
