import { randomUUID } from 'crypto'
import { createParser } from 'eventsource-parser'

/**
 * OpenAI Responses API (/v1/responses) <-> Chat Completions adapter.
 *
 * The gateway's providers all speak chat-completions internally, so this module
 * translates the request body down, and translates the response / SSE stream
 * back up into Responses-API events.
 */

type ResponsesItem = Record<string, any>

// ---------- request: Responses -> Chat Completions ----------

export function responsesRequestToChatCompletions(body: any): any {
  const messages: any[] = []

  const instructions = typeof body?.instructions === 'string' ? body.instructions.trim() : ''
  if (instructions) messages.push({ role: 'system', content: instructions })

  for (const message of responsesInputToMessages(body?.input)) {
    messages.push(message)
  }

  const converted: any = {
    model: body?.model,
    messages,
    stream: body?.stream === true
  }

  copyIfPresent(body, converted, 'temperature')
  copyIfPresent(body, converted, 'top_p')
  copyIfPresent(body, converted, 'metadata')
  copyIfPresent(body, converted, 'parallel_tool_calls')
  copyIfPresent(body, converted, 'user')
  copyIfPresent(body, converted, 'service_tier')
  copyIfPresent(body, converted, 'prompt_cache_key')
  copyIfPresent(body, converted, 'safety_identifier')
  copyIfPresent(body, converted, 'logprobs')
  copyIfPresent(body, converted, 'top_logprobs')
  if (body?.max_output_tokens !== undefined) {
    converted.max_completion_tokens = body.max_output_tokens
  }
  if (Array.isArray(body?.tools)) {
    const tools = body.tools.map(responsesToolToChat).filter(Boolean)
    if (tools.length) converted.tools = tools
  }
  const toolChoice = responsesToolChoiceToChat(body?.tool_choice)
  if (toolChoice !== undefined) converted.tool_choice = toolChoice
  const responseFormat = responsesTextFormatToResponseFormat(body?.text?.format)
  if (responseFormat) converted.response_format = responseFormat
  const effort = body?.reasoning?.effort
  if (typeof effort === 'string' && effort) converted.reasoning_effort = effort
  if (converted.stream) {
    const streamOptions =
      body?.stream_options && typeof body.stream_options === 'object' ? body.stream_options : {}
    converted.stream_options = { ...streamOptions, include_usage: true }
  }

  return converted
}

function responsesInputToMessages(input: unknown): any[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }]
  if (!Array.isArray(input)) return []

  const messages: any[] = []
  for (const item of input as ResponsesItem[]) {
    if (!item || typeof item !== 'object') continue
    const type = typeof item.type === 'string' ? item.type : 'message'
    if (type === 'message' || item.role) {
      messages.push(...responsesMessageToChat(item))
    } else if (type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: item.call_id || item.id || `call_${randomUUID().replace(/-/g, '')}`,
            type: 'function',
            function: {
              name: item.name || 'tool',
              arguments: typeof item.arguments === 'string' ? item.arguments : '{}'
            }
          }
        ]
      })
    } else if (type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || item.id || '',
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')
      })
    }
    // reasoning / item_reference / image_generation_call etc. can't be replayed
    // through chat completions — skip them.
  }
  return messages
}

function responsesMessageToChat(item: ResponsesItem): any[] {
  const role =
    item.role === 'assistant' || item.role === 'system' || item.role === 'developer'
      ? item.role === 'developer'
        ? 'system'
        : item.role
      : 'user'
  const content = item.content
  if (typeof content === 'string') return [{ role, content }]
  if (!Array.isArray(content)) return [{ role, content: '' }]

  const parts: any[] = []
  const toolCalls: any[] = []
  const toolOutputs: any[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const partType = part.type
    if (partType === 'input_text' || partType === 'output_text' || partType === 'text') {
      parts.push({ type: 'text', text: part.text || '' })
    } else if (partType === 'input_image') {
      const url = part.image_url || part.url
      if (url) parts.push({ type: 'image_url', image_url: { url } })
    } else if (partType === 'input_file' || partType === 'file') {
      parts.push({
        type: 'file',
        file: {
          file_data: part.file_data,
          file_id: part.file_id,
          filename: part.filename || part.file_name
        }
      })
    } else if (partType === 'refusal') {
      parts.push({ type: 'text', text: part.refusal || '' })
    }
  }

  const messages: any[] = []
  const compacted = compactContentParts(parts)
  messages.push(
    role === 'assistant'
      ? {
          role: 'assistant',
          content: compacted,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {})
        }
      : { role, content: compacted }
  )
  messages.push(...toolOutputs)
  return messages
}

function compactContentParts(parts: any[]): any {
  const normalized = parts.filter((part) => part.type !== 'text' || part.text)
  if (!normalized.length) return ''
  if (normalized.every((part) => part.type === 'text')) {
    return normalized.map((part) => part.text || '').join('\n')
  }
  return normalized
}

function responsesToolToChat(tool: any): any | undefined {
  if (!tool || typeof tool !== 'object') return undefined
  if (tool.type !== 'function') return undefined
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters || { type: 'object', properties: {} },
      ...(tool.strict !== undefined ? { strict: tool.strict } : {})
    }
  }
}

function responsesToolChoiceToChat(choice: any): any {
  if (choice === undefined || choice === null) return undefined
  if (choice === 'auto' || choice === 'required' || choice === 'none') return choice
  if (typeof choice === 'object') {
    if (choice.type === 'function' && choice.name) {
      return { type: 'function', function: { name: choice.name } }
    }
    if (choice.type === 'allowed_tools' && choice.mode) return choice.mode
  }
  return 'auto'
}

function responsesTextFormatToResponseFormat(format: any): any {
  if (!format || typeof format !== 'object') return undefined
  if (format.type === 'json_object') return { type: 'json_object' }
  if (format.type === 'json_schema') {
    return {
      type: 'json_schema',
      json_schema: {
        name: format.name || 'response',
        schema: format.schema || {},
        ...(format.strict !== undefined ? { strict: format.strict } : {}),
        ...(format.description !== undefined ? { description: format.description } : {})
      }
    }
  }
  return undefined
}

// ---------- non-stream response: Chat Completion -> Response object ----------

export function chatCompletionToResponsesResponse(completion: any, requestBody: any): any {
  const id = `resp_${randomUUID().replace(/-/g, '')}`
  const createdAt = completion?.created ?? Math.floor(Date.now() / 1000)
  const choice = completion?.choices?.[0] ?? {}
  const message = choice.message ?? {}
  const { output, text } = chatMessageToResponsesOutput(message)
  const finishReason = choice.finish_reason
  const status =
    finishReason === 'stop' || finishReason === 'tool_calls' || !finishReason
      ? 'completed'
      : 'incomplete'
  const incompleteDetails =
    finishReason === 'length'
      ? { reason: 'max_output_tokens' }
      : finishReason === 'content_filter'
        ? { reason: 'content_filter' }
        : null
  const usage = completion?.usage

  return {
    id,
    object: 'response',
    created_at: createdAt,
    status,
    error: null,
    incomplete_details: incompleteDetails,
    instructions: requestBody?.instructions ?? null,
    max_output_tokens: requestBody?.max_output_tokens ?? null,
    model: completion?.model || requestBody?.model,
    previous_response_id: requestBody?.previous_response_id ?? null,
    output,
    output_text: text,
    parallel_tool_calls: requestBody?.parallel_tool_calls ?? true,
    tool_choice: requestBody?.tool_choice ?? 'auto',
    tools: Array.isArray(requestBody?.tools) ? requestBody.tools : [],
    temperature: requestBody?.temperature ?? 1,
    top_p: requestBody?.top_p ?? 1,
    reasoning: {
      effort: requestBody?.reasoning?.effort ?? null,
      summary: null
    },
    store: requestBody?.store ?? true,
    text: requestBody?.text ?? { format: { type: 'text' } },
    truncation: requestBody?.truncation ?? 'disabled',
    user: requestBody?.user ?? null,
    metadata: requestBody?.metadata ?? {},
    usage: usage
      ? {
          input_tokens: numeric(usage.prompt_tokens ?? usage.input_tokens),
          input_tokens_details: {
            cached_tokens: numeric(usage.prompt_tokens_details?.cached_tokens)
          },
          output_tokens: numeric(usage.completion_tokens ?? usage.output_tokens),
          output_tokens_details: {
            reasoning_tokens: numeric(usage.completion_tokens_details?.reasoning_tokens)
          },
          total_tokens: numeric(usage.total_tokens)
        }
      : null
  }
}

function chatMessageToResponsesOutput(message: any): {
  output: ResponsesItem[]
  text: string
  reasoning: string
} {
  const output: ResponsesItem[] = []
  const reasoning = extractReasoningText(message)
  if (reasoning) {
    output.push({
      id: `rs_${randomUUID().replace(/-/g, '')}`,
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: reasoning }],
      content: [{ type: 'reasoning_text', text: reasoning }],
      status: 'completed'
    })
  }

  const text = extractContentText(message?.content)
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
  const hasToolCalls = toolCalls.length > 0
  if (text || !hasToolCalls) {
    output.push({
      id: `msg_${randomUUID().replace(/-/g, '')}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }]
    })
  }
  for (const call of toolCalls) {
    output.push({
      id: `fc_${randomUUID().replace(/-/g, '')}`,
      type: 'function_call',
      call_id: call.id || `call_${randomUUID().replace(/-/g, '')}`,
      name: call.function?.name || 'tool',
      arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : '{}',
      status: 'completed'
    })
  }
  return { output, text, reasoning }
}

function extractContentText(content: unknown): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content)
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (!part || typeof part !== 'object') return ''
      return (part as any).text || ''
    })
    .filter(Boolean)
    .join('')
}

function extractReasoningText(message: any): string {
  const value = message?.reasoning_content ?? message?.reasoning
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === 'string' ? part : (part as any)?.text || ''))
      .filter(Boolean)
      .join('')
  }
  return ''
}

// ---------- streaming: chat SSE -> Responses SSE ----------

export async function* chatCompletionSseToResponsesSse(
  source: AsyncIterable<string | Uint8Array>,
  requestBody: any
): AsyncGenerator<string> {
  const responseId = `resp_${randomUUID().replace(/-/g, '')}`
  const createdAt = Math.floor(Date.now() / 1000)
  let model = requestBody?.model || ''
  let sequence = 0
  let completed = false

  // output items accumulate for the final response.completed payload
  const items: ResponsesItem[] = []
  let messageItemIndex = -1
  let messageItemId = ''
  let messageText = ''
  let reasoningItemIndex = -1
  let reasoningItemId = ''
  let reasoningText = ''
  const toolCalls = new Map<
    number,
    { outputIndex: number; itemId: string; callId: string; name: string; arguments: string }
  >()
  let lastFinishReason: string | null = null
  let usage: any = null

  const emit = (type: string, payload: Record<string, any>): string =>
    sseEvent(type, { type, sequence_number: sequence++, ...payload })

  const baseResponse = (status: string): Record<string, any> => ({
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status,
    error: null,
    incomplete_details: null,
    instructions: requestBody?.instructions ?? null,
    max_output_tokens: requestBody?.max_output_tokens ?? null,
    model,
    previous_response_id: requestBody?.previous_response_id ?? null,
    output: [],
    parallel_tool_calls: requestBody?.parallel_tool_calls ?? true,
    tool_choice: requestBody?.tool_choice ?? 'auto',
    tools: Array.isArray(requestBody?.tools) ? requestBody.tools : [],
    temperature: requestBody?.temperature ?? 1,
    top_p: requestBody?.top_p ?? 1,
    reasoning: { effort: requestBody?.reasoning?.effort ?? null, summary: null },
    store: requestBody?.store ?? true,
    text: requestBody?.text ?? { format: { type: 'text' } },
    truncation: requestBody?.truncation ?? 'disabled',
    user: requestBody?.user ?? null,
    metadata: requestBody?.metadata ?? {},
    usage: null
  })

  let started = false
  function* startEvents(): Generator<string> {
    if (started) return
    started = true
    yield emit('response.created', { response: baseResponse('in_progress') })
    yield emit('response.in_progress', { response: baseResponse('in_progress') })
  }

  function* ensureReasoningItem(): Generator<string> {
    yield* startEvents()
    if (reasoningItemIndex >= 0) return
    reasoningItemIndex = items.length
    reasoningItemId = `rs_${randomUUID().replace(/-/g, '')}`
    items.push({
      id: reasoningItemId,
      type: 'reasoning',
      summary: [],
      content: [],
      status: 'in_progress'
    })
    yield emit('response.output_item.added', {
      output_index: reasoningItemIndex,
      item: { ...items[reasoningItemIndex] }
    })
    yield emit('response.reasoning_summary_part.added', {
      item_id: reasoningItemId,
      output_index: reasoningItemIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: '' }
    })
  }

  function* closeReasoningItem(): Generator<string> {
    if (reasoningItemIndex < 0) return
    if (items[reasoningItemIndex]?.status !== 'in_progress') return
    yield emit('response.reasoning_summary_text.done', {
      item_id: reasoningItemId,
      output_index: reasoningItemIndex,
      summary_index: 0,
      text: reasoningText
    })
    yield emit('response.reasoning_summary_part.done', {
      item_id: reasoningItemId,
      output_index: reasoningItemIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: reasoningText }
    })
    items[reasoningItemIndex] = {
      id: reasoningItemId,
      type: 'reasoning',
      summary: reasoningText ? [{ type: 'summary_text', text: reasoningText }] : [],
      content: reasoningText ? [{ type: 'reasoning_text', text: reasoningText }] : [],
      status: 'completed'
    }
    yield emit('response.output_item.done', {
      output_index: reasoningItemIndex,
      item: items[reasoningItemIndex]
    })
  }

  function* ensureMessageItem(): Generator<string> {
    yield* startEvents()
    if (messageItemIndex >= 0) return
    yield* closeReasoningItem()
    messageItemIndex = items.length
    messageItemId = `msg_${randomUUID().replace(/-/g, '')}`
    const item = {
      id: messageItemId,
      type: 'message',
      status: 'in_progress',
      role: 'assistant',
      content: [{ type: 'output_text', text: '', annotations: [] }]
    }
    items.push(item)
    yield emit('response.output_item.added', { output_index: messageItemIndex, item })
    yield emit('response.content_part.added', {
      item_id: messageItemId,
      output_index: messageItemIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] }
    })
  }

  function* closeMessageItem(): Generator<string> {
    if (messageItemIndex < 0) return
    if (items[messageItemIndex]?.status !== 'in_progress') return
    yield emit('response.output_text.done', {
      item_id: messageItemId,
      output_index: messageItemIndex,
      content_index: 0,
      text: messageText
    })
    yield emit('response.content_part.done', {
      item_id: messageItemId,
      output_index: messageItemIndex,
      content_index: 0,
      part: { type: 'output_text', text: messageText, annotations: [] }
    })
    items[messageItemIndex] = {
      id: messageItemId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: messageText, annotations: [] }]
    }
    yield emit('response.output_item.done', {
      output_index: messageItemIndex,
      item: items[messageItemIndex]
    })
  }

  function* ensureToolCall(index: number): Generator<string> {
    yield* startEvents()
    if (toolCalls.has(index)) return
    yield* closeReasoningItem()
    yield* closeMessageItem()
    const outputIndex = items.length
    const entry = {
      outputIndex,
      itemId: `fc_${randomUUID().replace(/-/g, '')}`,
      callId: '',
      name: '',
      arguments: ''
    }
    toolCalls.set(index, entry)
    items.push({
      id: entry.itemId,
      type: 'function_call',
      call_id: '',
      name: '',
      arguments: '',
      status: 'in_progress'
    })
    yield emit('response.output_item.added', {
      output_index: outputIndex,
      item: items[outputIndex]
    })
  }

  function* closeToolCall(entry: {
    outputIndex: number
    itemId: string
    callId: string
    name: string
    arguments: string
  }): Generator<string> {
    yield emit('response.function_call_arguments.done', {
      item_id: entry.itemId,
      output_index: entry.outputIndex,
      arguments: entry.arguments
    })
    items[entry.outputIndex] = {
      id: entry.itemId,
      type: 'function_call',
      call_id: entry.callId,
      name: entry.name,
      arguments: entry.arguments,
      status: 'completed'
    }
    yield emit('response.output_item.done', {
      output_index: entry.outputIndex,
      item: items[entry.outputIndex]
    })
  }

  function* finalize(): Generator<string> {
    yield* startEvents()
    yield* closeReasoningItem()
    yield* closeMessageItem()
    for (const entry of [...toolCalls.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
      if (items[entry.outputIndex]?.status === 'in_progress') yield* closeToolCall(entry)
    }
    const status =
      lastFinishReason === 'length'
        ? 'incomplete'
        : lastFinishReason === 'content_filter'
          ? 'incomplete'
          : 'completed'
    const finalResponse = {
      ...baseResponse(status),
      output: items,
      output_text: messageText,
      usage: usage
        ? {
            input_tokens: numeric(usage.prompt_tokens ?? usage.input_tokens),
            input_tokens_details: {
              cached_tokens: numeric(usage.prompt_tokens_details?.cached_tokens)
            },
            output_tokens: numeric(usage.completion_tokens ?? usage.output_tokens),
            output_tokens_details: {
              reasoning_tokens: numeric(usage.completion_tokens_details?.reasoning_tokens)
            },
            total_tokens: numeric(usage.total_tokens)
          }
        : null,
      incomplete_details:
        lastFinishReason === 'length'
          ? { reason: 'max_output_tokens' }
          : lastFinishReason === 'content_filter'
            ? { reason: 'content_filter' }
            : null
    }
    yield emit(status === 'completed' ? 'response.completed' : 'response.incomplete', {
      response: finalResponse
    })
    completed = true
  }

  for await (const event of parseSseEvents(source)) {
    if (event === '[DONE]') {
      if (!completed) yield* finalize()
      continue
    }

    let payload: any
    try {
      payload = JSON.parse(event)
    } catch {
      continue
    }

    if (payload?.error) {
      yield* startEvents()
      yield emit('response.failed', {
        response: {
          ...baseResponse('failed'),
          error: {
            code: payload.error.type || payload.error.code || 'api_error',
            message: payload.error.message || JSON.stringify(payload.error)
          }
        }
      })
      completed = true
      break
    }

    if (payload?.model) model = payload.model
    if (payload?.usage) usage = payload.usage

    const choice = payload?.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? {}

    const reasoning = extractDeltaText(delta.reasoning_content ?? delta.reasoning)
    if (reasoning) {
      yield* ensureReasoningItem()
      reasoningText += reasoning
      yield emit('response.reasoning_summary_text.delta', {
        item_id: reasoningItemId,
        output_index: reasoningItemIndex,
        summary_index: 0,
        delta: reasoning
      })
    }

    const text = extractDeltaText(delta.content)
    if (text) {
      yield* ensureMessageItem()
      messageText += text
      yield emit('response.output_text.delta', {
        item_id: messageItemId,
        output_index: messageItemIndex,
        content_index: 0,
        delta: text
      })
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const index = Number.isInteger(call?.index) ? call.index : toolCalls.size
        yield* ensureToolCall(index)
        const entry = toolCalls.get(index)!
        if (call.id) entry.callId = call.id
        if (call.function?.name) entry.name = `${entry.name}${call.function.name}`
        if (call.function?.arguments) {
          entry.arguments += call.function.arguments
          yield emit('response.function_call_arguments.delta', {
            item_id: entry.itemId,
            output_index: entry.outputIndex,
            delta: call.function.arguments
          })
        }
      }
    }

    if (choice.finish_reason) lastFinishReason = choice.finish_reason
  }

  if (!completed) yield* finalize()
}

function extractDeltaText(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === 'string' ? part : (part as any)?.text || ''))
      .filter(Boolean)
      .join('')
  }
  return ''
}

async function* parseSseEvents(source: AsyncIterable<string | Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  const pending: string[] = []
  const parser = createParser({
    maxBufferSize: 1024 * 1024,
    onEvent: (event) => pending.push(event.data)
  })

  for await (const chunk of source) {
    parser.feed(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }))
    while (pending.length) yield pending.shift()!
  }
  const tail = decoder.decode()
  if (tail) parser.feed(tail)
  parser.reset({ consume: true })
  while (pending.length) yield pending.shift()!
}

function sseEvent(type: string, payload: Record<string, any>): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
}

function numeric(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function copyIfPresent(source: any, target: any, key: string): void {
  if (source?.[key] !== undefined) target[key] = source[key]
}
