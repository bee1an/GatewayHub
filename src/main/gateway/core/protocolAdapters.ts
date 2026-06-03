import { randomUUID } from 'crypto'

type AnthropicContentBlock = {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  source?: {
    type?: string
    media_type?: string
    data?: string
    url?: string
  }
  [key: string]: unknown
}

type OpenAIToolCallAccumulator = {
  id?: string
  name?: string
  arguments: string
}

export function anthropicMessagesToOpenAIChatCompletions(body: any, model: string): any {
  const messages: any[] = []
  const system = extractAnthropicText(body?.system).trim()
  if (system) messages.push({ role: 'system', content: system })

  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    messages.push(...anthropicMessageToOpenAI(message))
  }

  const converted: any = {
    model,
    messages,
    stream: body?.stream === true
  }

  copyIfPresent(body, converted, 'temperature')
  copyIfPresent(body, converted, 'top_p')
  copyIfPresent(body, converted, 'metadata')
  if (body?.max_tokens !== undefined) converted.max_tokens = body.max_tokens
  if (body?.stop_sequences !== undefined) converted.stop = body.stop_sequences
  if (Array.isArray(body?.tools)) converted.tools = body.tools.map(anthropicToolToOpenAI)
  if (body?.tool_choice) converted.tool_choice = anthropicToolChoiceToOpenAI(body.tool_choice)

  return converted
}

export function openAIChatCompletionToAnthropicMessage(
  completion: any,
  model: string,
  originalBody?: any
): any {
  const choice = completion?.choices?.[0] ?? {}
  const message = choice.message ?? {}
  const usage = completion?.usage ?? {}
  return {
    id: toAnthropicMessageId(completion?.id),
    type: 'message',
    role: 'assistant',
    model: completion?.model || model,
    content: openAIMessageToAnthropicContent(message),
    stop_reason: openAIFinishReasonToAnthropic(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens:
        numeric(usage.prompt_tokens ?? usage.input_tokens) || estimateInput(originalBody),
      output_tokens: numeric(usage.completion_tokens ?? usage.output_tokens)
    }
  }
}

export async function* openAIChatCompletionSseToAnthropicMessageSse(
  source: AsyncIterable<string | Uint8Array>,
  model: string
): AsyncGenerator<string> {
  const id = `msg_${randomUUID().replace(/-/g, '')}`
  let messageStarted = false
  let textBlockOpen = false
  let anyContentBlock = false
  let blockIndex = 0
  let stopReason = 'end_turn'
  let usage = { input_tokens: 0, output_tokens: 0 }
  const toolCalls = new Map<number, OpenAIToolCallAccumulator>()

  const ensureMessage = function* (): Generator<string> {
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

  const ensureTextBlock = function* (): Generator<string> {
    yield* ensureMessage()
    if (textBlockOpen) return
    textBlockOpen = true
    anyContentBlock = true
    yield sseEvent('content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'text', text: '' }
    })
  }

  const closeTextBlock = function* (): Generator<string> {
    if (!textBlockOpen) return
    yield sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })
    textBlockOpen = false
    blockIndex += 1
  }

  const finalize = function* (): Generator<string> {
    yield* ensureMessage()
    yield* closeTextBlock()
    if (toolCalls.size) {
      for (const [index, call] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
        const toolIndex = blockIndex++
        anyContentBlock = true
        const name = call.name || `tool_${index}`
        yield sseEvent('content_block_start', {
          type: 'content_block_start',
          index: toolIndex,
          content_block: {
            type: 'tool_use',
            id: call.id || `toolu_${randomUUID().replace(/-/g, '')}`,
            name,
            input: {}
          }
        })
        yield sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: toolIndex,
          delta: { type: 'input_json_delta', partial_json: call.arguments || '{}' }
        })
        yield sseEvent('content_block_stop', { type: 'content_block_stop', index: toolIndex })
      }
      stopReason = 'tool_use'
    }
    if (!anyContentBlock) {
      yield sseEvent('content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'text', text: '' }
      })
      yield sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex })
    }
    yield sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage
    })
    yield sseEvent('message_stop', { type: 'message_stop' })
  }

  let completed = false
  for await (const event of parseOpenAISseEvents(source)) {
    if (event === '[DONE]') {
      if (!completed) {
        yield* finalize()
        completed = true
      }
      continue
    }

    let payload: any
    try {
      payload = JSON.parse(event)
    } catch {
      continue
    }

    if (payload?.error) {
      yield sseEvent('error', {
        type: 'error',
        error: {
          type: payload.error.type || 'api_error',
          message: payload.error.message || JSON.stringify(payload.error)
        }
      })
      completed = true
      break
    }

    if (payload?.model) model = payload.model
    if (payload?.usage) usage = openAIUsageToAnthropic(payload.usage)

    const choice = payload?.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? {}
    if (typeof delta.content === 'string' && delta.content) {
      yield* ensureTextBlock()
      yield sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'text_delta', text: delta.content }
      })
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const item of delta.tool_calls) {
        const index = Number.isInteger(item?.index) ? item.index : toolCalls.size
        const current = toolCalls.get(index) ?? { arguments: '' }
        if (item.id) current.id = item.id
        if (item.function?.name) current.name = `${current.name ?? ''}${item.function.name}`
        if (item.function?.arguments) current.arguments += item.function.arguments
        toolCalls.set(index, current)
      }
    }
    if (choice.finish_reason) stopReason = openAIFinishReasonToAnthropic(choice.finish_reason)
  }

  if (!completed) yield* finalize()
}

function anthropicMessageToOpenAI(message: any): any[] {
  const role = message?.role === 'assistant' ? 'assistant' : 'user'
  const content = message?.content
  if (role === 'assistant') return [anthropicAssistantMessageToOpenAI(content)]
  return anthropicUserMessageToOpenAI(content)
}

function anthropicAssistantMessageToOpenAI(content: unknown): any {
  if (typeof content === 'string') return { role: 'assistant', content }
  const blocks = Array.isArray(content) ? (content as AnthropicContentBlock[]) : []
  const text = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text || '')
    .join('\n')
  const toolCalls = blocks
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({
      id: block.id || `toolu_${randomUUID().replace(/-/g, '')}`,
      type: 'function',
      function: { name: block.name || 'tool', arguments: stringifyJson(block.input ?? {}) }
    }))
  const message: any = { role: 'assistant', content: text || (toolCalls.length ? null : '') }
  if (toolCalls.length) message.tool_calls = toolCalls
  return message
}

function anthropicUserMessageToOpenAI(content: unknown): any[] {
  if (typeof content === 'string') return [{ role: 'user', content }]
  const blocks = Array.isArray(content) ? (content as AnthropicContentBlock[]) : []
  const userParts: any[] = []
  const messages: any[] = []

  for (const block of blocks) {
    if (block.type === 'tool_result') {
      if (userParts.length) {
        messages.push({ role: 'user', content: compactOpenAIContent(userParts.splice(0)) })
      }
      messages.push({
        role: 'tool',
        tool_call_id: block.tool_use_id || block.id || `toolu_${randomUUID().replace(/-/g, '')}`,
        content: extractAnthropicText(block.content)
      })
      continue
    }
    const part = anthropicBlockToOpenAIContentPart(block)
    if (part) userParts.push(part)
  }
  if (userParts.length || !messages.length) {
    messages.push({ role: 'user', content: compactOpenAIContent(userParts) })
  }
  return messages
}

function anthropicBlockToOpenAIContentPart(block: AnthropicContentBlock): any | undefined {
  if (!block || block.type === 'text' || !block.type) {
    return { type: 'text', text: block?.text || '' }
  }
  if (block.type === 'image' && block.source) {
    const url =
      block.source.type === 'base64'
        ? `data:${block.source.media_type || 'image/png'};base64,${block.source.data || ''}`
        : block.source.url
    if (url) return { type: 'image_url', image_url: { url } }
  }
  return { type: 'text', text: extractAnthropicText(block) }
}

function compactOpenAIContent(parts: any[]): any {
  const normalized = parts.filter((part) => part.type !== 'text' || part.text)
  if (!normalized.length) return ''
  if (normalized.every((part) => part.type === 'text')) {
    return normalized.map((part) => part.text || '').join('\n')
  }
  return normalized
}

function anthropicToolToOpenAI(tool: any): any {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema || { type: 'object', properties: {} }
    }
  }
}

function anthropicToolChoiceToOpenAI(choice: any): any {
  if (choice?.type === 'auto') return 'auto'
  if (choice?.type === 'any') return 'required'
  if (choice?.type === 'none') return 'none'
  if (choice?.type === 'tool') return { type: 'function', function: { name: choice.name } }
  return choice
}

function openAIMessageToAnthropicContent(message: any): any[] {
  const blocks: any[] = []
  const text = extractOpenAIText(message?.content)
  if (text) blocks.push({ type: 'text', text })
  for (const call of message?.tool_calls || []) {
    blocks.push({
      type: 'tool_use',
      id: call.id || `toolu_${randomUUID().replace(/-/g, '')}`,
      name: call.function?.name || 'tool',
      input: parseJsonObject(call.function?.arguments)
    })
  }
  if (!blocks.length) blocks.push({ type: 'text', text: '' })
  return blocks
}

function extractAnthropicText(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part
        if (!part || typeof part !== 'object') return ''
        const block = part as AnthropicContentBlock
        if (block.type === 'text' || block.text) return block.text || ''
        if (block.type === 'tool_result') return extractAnthropicText(block.content)
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (typeof value === 'object') {
    const block = value as AnthropicContentBlock
    return block.text || extractAnthropicText(block.content)
  }
  return String(value)
}

function extractOpenAIText(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return String(value)
  return value
    .map((part) => {
      if (typeof part === 'string') return part
      if (!part || typeof part !== 'object') return ''
      const obj = part as any
      return obj.text || ''
    })
    .filter(Boolean)
    .join('\n')
}

async function* parseOpenAISseEvents(
  source: AsyncIterable<string | Uint8Array>
): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of source) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    buffer = buffer.replace(/\r\n/g, '\n')
    while (true) {
      const index = buffer.indexOf('\n\n')
      if (index === -1) break
      const raw = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const data = raw
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (data) yield data
    }
  }
  const tail = buffer.trim()
  if (tail.startsWith('data:')) yield tail.slice(5).trimStart()
}

function openAIUsageToAnthropic(usage: any): { input_tokens: number; output_tokens: number } {
  return {
    input_tokens: numeric(usage?.prompt_tokens ?? usage?.input_tokens),
    output_tokens: numeric(usage?.completion_tokens ?? usage?.output_tokens)
  }
}

function openAIFinishReasonToAnthropic(reason: unknown): string {
  if (reason === 'length') return 'max_tokens'
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use'
  if (reason === 'stop' || reason == null) return 'end_turn'
  return String(reason)
}

function toAnthropicMessageId(value: unknown): string {
  const text = typeof value === 'string' ? value : ''
  if (text.startsWith('msg_')) return text
  return `msg_${randomUUID().replace(/-/g, '')}`
}

function estimateInput(body: any): number {
  const text = JSON.stringify(body ?? '')
  return Math.max(1, Math.ceil(text.length / 4))
}

function numeric(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

function copyIfPresent(source: any, target: any, key: string): void {
  if (source?.[key] !== undefined) target[key] = source[key]
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

function parseJsonObject(value: unknown): any {
  if (!value) return {}
  if (typeof value === 'object') return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? parsed : { value: parsed }
    } catch {
      return { arguments: value }
    }
  }
  return { value }
}

function sseEvent(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}
