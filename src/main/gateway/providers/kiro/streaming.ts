import { randomUUID } from 'crypto'
import { estimateTokens, sseData } from '../../core/utils'
import { anthropicInputTokens, openAiUsageFromBodies } from './converters'

export interface KiroEvent {
  type: 'content' | 'thinking' | 'tool_use' | 'usage' | 'context_usage'
  content?: string
  thinking?: string
  toolUse?: any
  usage?: any
}

export class FirstTokenTimeoutError extends Error {}

export class AwsEventStreamParser {
  private buffer = ''
  private lastContent = ''
  private currentToolCall: any | undefined
  private currentToolInputs: any[] = []
  private toolCalls: any[] = []
  private readonly decoder = new TextDecoder('utf-8')

  feed(chunk: Uint8Array): KiroEvent[] {
    this.buffer += this.decoder.decode(chunk, { stream: true })
    const events: KiroEvent[] = []
    while (true) {
      const next = this.findNextJson()
      if (!next) break
      const end = findMatchingBrace(this.buffer, next.pos)
      if (end === -1) break
      const json = this.buffer.slice(next.pos, end + 1)
      this.buffer = this.buffer.slice(end + 1)
      try {
        const data = JSON.parse(json)
        const processed = this.process(data, next.type)
        if (processed) events.push(processed)
      } catch {
        // Ignore malformed fragments; the upstream stream may include binary event framing.
      }
    }
    return events
  }

  finish(): KiroEvent[] {
    if (this.currentToolCall) this.finalizeToolCall()
    return dedupeToolCalls(this.toolCalls).map((toolUse) => ({
      type: 'tool_use' as const,
      toolUse
    }))
  }

  private findNextJson(): { pos: number; type: string } | undefined {
    const patterns: Array<[string, string]> = [
      ['{"content":', 'content'],
      ['{"name":', 'tool_start'],
      ['{"input":', 'tool_input'],
      ['{"stop":', 'tool_stop'],
      ['{"usage":', 'usage'],
      ['{"contextUsagePercentage":', 'context_usage']
    ]
    let best: { pos: number; type: string } | undefined
    for (const [pattern, type] of patterns) {
      const pos = this.buffer.indexOf(pattern)
      if (pos !== -1 && (!best || pos < best.pos)) best = { pos, type }
    }
    return best
  }

  private process(data: any, type: string): KiroEvent | undefined {
    if (type === 'content') {
      if (data.followupPrompt) return undefined
      const content = data.content ?? ''
      if (!content || content === this.lastContent) return undefined
      this.lastContent = content
      return { type: 'content', content }
    }
    if (type === 'tool_start') {
      if (this.currentToolCall) this.finalizeToolCall()
      this.currentToolCall = {
        id: data.toolUseId || randomUUID(),
        type: 'function',
        function: {
          name: data.name || '',
          arguments: '{}'
        }
      }
      this.currentToolInputs = []
      this.appendToolInput(data.input)
      if (data.stop) this.finalizeToolCall()
      return undefined
    }
    if (type === 'tool_input') {
      if (this.currentToolCall) this.appendToolInput(data.input)
      return undefined
    }
    if (type === 'tool_stop') {
      if (this.currentToolCall && data.stop) this.finalizeToolCall()
      return undefined
    }
    if (type === 'usage') return { type: 'usage', usage: data.usage }
    if (type === 'context_usage')
      return { type: 'context_usage', usage: data.contextUsagePercentage }
    return undefined
  }

  private finalizeToolCall(): void {
    if (!this.currentToolCall) return
    this.currentToolCall.function.arguments = JSON.stringify(
      normalizeToolInput(this.currentToolInputs)
    )
    this.toolCalls.push(this.currentToolCall)
    this.currentToolCall = undefined
    this.currentToolInputs = []
  }

  private appendToolInput(input: any): void {
    if (input === undefined || input === null || input === '') return
    this.currentToolInputs.push(input)
  }
}

export async function* parseKiroStream(
  body: ReadableStream<Uint8Array>,
  firstTokenTimeoutSeconds: number
): AsyncGenerator<KiroEvent> {
  const parser = new AwsEventStreamParser()
  const thinking = new ThinkingTagParser()
  const reader = body.getReader()

  const first = await readWithTimeout(reader, firstTokenTimeoutSeconds * 1000)
  if (first.done) return
  for (const event of parser.feed(first.value))
    for (const processed of thinking.process(event)) yield processed

  while (true) {
    const next = await reader.read()
    if (next.done) break
    for (const event of parser.feed(next.value))
      for (const processed of thinking.process(event)) yield processed
  }
  for (const event of thinking.finish()) yield event
  for (const event of parser.finish()) yield event
}

async function readWithTimeout(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
        timer = setTimeout(
          () => reject(new FirstTokenTimeoutError(`No Kiro token within ${timeoutMs / 1000}s`)),
          timeoutMs
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

class ThinkingTagParser {
  private inThinking = false
  private carry = ''

  process(event: KiroEvent): KiroEvent[] {
    if (event.type !== 'content' || !event.content) return [event]
    const out: KiroEvent[] = []
    let text = this.carry + event.content
    this.carry = ''
    while (text) {
      const tag = this.inThinking ? '</thinking>' : '<thinking>'
      const idx = text.indexOf(tag)
      if (idx === -1) {
        const carry = ThinkingTagParser.tagPrefixSuffix(text, tag)
        const head = carry ? text.slice(0, -carry.length) : text
        if (head) out.push(this.emit(head))
        this.carry = carry
        return out
      }
      const head = text.slice(0, idx)
      if (head) out.push(this.emit(head))
      this.inThinking = !this.inThinking
      text = text.slice(idx + tag.length)
    }
    return out
  }

  finish(): KiroEvent[] {
    if (!this.carry) return []
    const out = this.emit(this.carry)
    this.carry = ''
    return [out]
  }

  private emit(text: string): KiroEvent {
    return this.inThinking
      ? { type: 'thinking', thinking: text }
      : { type: 'content', content: text }
  }

  private static tagPrefixSuffix(text: string, tag: string): string {
    const max = Math.min(text.length, tag.length - 1)
    for (let length = max; length > 0; length--) {
      const suffix = text.slice(-length)
      if (tag.startsWith(suffix)) return suffix
    }
    return ''
  }
}

export async function collectKiroStream(
  body: ReadableStream<Uint8Array>,
  firstTokenTimeoutSeconds: number
) {
  let content = ''
  let thinking = ''
  const toolCalls: any[] = []
  for await (const event of parseKiroStream(body, firstTokenTimeoutSeconds)) {
    if (event.type === 'content') content += event.content ?? ''
    else if (event.type === 'thinking') thinking += event.thinking ?? ''
    else if (event.type === 'tool_use') toolCalls.push(event.toolUse)
  }
  return { content, thinking, toolCalls }
}

export async function* openAiSseFromKiro(
  body: ReadableStream<Uint8Array>,
  model: string,
  requestBody: any,
  firstTokenTimeoutSeconds: number
): AsyncGenerator<string> {
  const id = `chatcmpl-${randomUUID().replace(/-/g, '')}`
  const created = Math.floor(Date.now() / 1000)
  let first = true
  let content = ''
  let thinking = ''
  const toolCalls: any[] = []

  for await (const event of parseKiroStream(body, firstTokenTimeoutSeconds)) {
    if (event.type === 'content' && event.content) {
      content += event.content
      yield sseData({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { ...(first ? { role: 'assistant' } : {}), content: event.content },
            finish_reason: null
          }
        ]
      })
      first = false
    } else if (event.type === 'thinking' && event.thinking) {
      thinking += event.thinking
      yield sseData({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { ...(first ? { role: 'assistant' } : {}), reasoning_content: event.thinking },
            finish_reason: null
          }
        ]
      })
      first = false
    } else if (event.type === 'tool_use' && event.toolUse) {
      toolCalls.push(event.toolUse)
    }
  }

  if (toolCalls.length) {
    const delta = {
      ...(first ? { role: 'assistant' } : {}),
      tool_calls: toolCalls.map((tool, index) => ({ ...tool, index }))
    }
    yield sseData({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: null }]
    })
    first = false
  }
  const usage = openAiUsageFromBodies(requestBody, content + thinking)
  yield sseData({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
    usage
  })
  yield 'data: [DONE]\n\n'
}

export async function openAiJsonFromKiro(
  body: ReadableStream<Uint8Array>,
  model: string,
  requestBody: any,
  firstTokenTimeoutSeconds: number
) {
  const result = await collectKiroStream(body, firstTokenTimeoutSeconds)
  const message: any = { role: 'assistant', content: result.content }
  if (result.thinking) message.reasoning_content = result.thinking
  if (result.toolCalls.length) message.tool_calls = result.toolCalls
  return {
    id: `chatcmpl-${randomUUID().replace(/-/g, '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message, finish_reason: result.toolCalls.length ? 'tool_calls' : 'stop' }
    ],
    usage: openAiUsageFromBodies(requestBody, result.content + result.thinking)
  }
}

export async function* anthropicSseFromKiro(
  body: ReadableStream<Uint8Array>,
  model: string,
  requestBody: any,
  firstTokenTimeoutSeconds: number
): AsyncGenerator<string> {
  const id = `msg_${randomUUID().replace(/-/g, '')}`
  const input_tokens = anthropicInputTokens(requestBody)
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
      usage: { input_tokens, output_tokens: 0 }
    }
  })
  let index = 0
  let openBlock: 'thinking' | 'text' | undefined
  let content = ''
  let thinking = ''
  const toolCalls: any[] = []

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

  for await (const event of parseKiroStream(body, firstTokenTimeoutSeconds)) {
    if (event.type === 'thinking' && event.thinking) {
      thinking += event.thinking
      for (const frame of ensureBlock('thinking')) yield frame
      yield sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: event.thinking }
      })
    } else if (event.type === 'content' && event.content) {
      content += event.content
      for (const frame of ensureBlock('text')) yield frame
      yield sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: event.content }
      })
    } else if (event.type === 'tool_use' && event.toolUse) toolCalls.push(event.toolUse)
  }
  for (const frame of closeOpenBlock()) yield frame
  for (const tool of toolCalls) {
    const input = safeJson(tool.function?.arguments)
    yield sseEvent('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'tool_use',
        id: tool.id,
        name: tool.function?.name || tool.name,
        input: {}
      }
    })
    yield sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) }
    })
    yield sseEvent('content_block_stop', { type: 'content_block_stop', index })
    index += 1
  }
  const output_tokens = estimateTokens(content) + estimateTokens(thinking)
  yield sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: toolCalls.length ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens }
  })
  yield sseEvent('message_stop', { type: 'message_stop' })
}

export async function anthropicJsonFromKiro(
  body: ReadableStream<Uint8Array>,
  model: string,
  requestBody: any,
  firstTokenTimeoutSeconds: number
) {
  const result = await collectKiroStream(body, firstTokenTimeoutSeconds)
  const content: any[] = []
  if (result.thinking) content.push({ type: 'thinking', thinking: result.thinking })
  if (result.content) content.push({ type: 'text', text: result.content })
  for (const tool of result.toolCalls)
    content.push({
      type: 'tool_use',
      id: tool.id,
      name: tool.function?.name || tool.name,
      input: safeJson(tool.function?.arguments)
    })
  return {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: result.toolCalls.length ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: anthropicInputTokens(requestBody),
      output_tokens: estimateTokens(result.content) + estimateTokens(result.thinking)
    }
  }
}

function sseEvent(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function findMatchingBrace(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\' && inString) {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (!inString && ch === '{') depth += 1
    if (!inString && ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function dedupeToolCalls(toolCalls: any[]): any[] {
  const byIdentity = new Map<string, { tool: any; input: Record<string, any> }>()
  const order: string[] = []

  for (const tool of toolCalls) {
    const identity = `${tool.id}:${tool.function?.name || tool.name || ''}`
    const nextInput = safeJson(tool.function?.arguments)
    const previous = byIdentity.get(identity)
    if (!previous) {
      byIdentity.set(identity, { tool, input: nextInput })
      order.push(identity)
      continue
    }

    const mergedInput = mergeToolInput(previous.input, nextInput)
    const preferred =
      Object.keys(nextInput).length > Object.keys(previous.input).length ? tool : previous.tool
    byIdentity.set(identity, { tool: preferred, input: mergedInput })
  }

  return order
    .map((identity) => byIdentity.get(identity))
    .filter((entry): entry is { tool: any; input: Record<string, any> } => Boolean(entry))
    .map(({ tool, input }) => toolWithArguments(tool, input))
}

function toolWithArguments(tool: any, input: Record<string, any>): any {
  return {
    ...tool,
    function: {
      ...(tool.function ?? {}),
      name: tool.function?.name || tool.name || '',
      arguments: JSON.stringify(input)
    }
  }
}

function normalizeToolInput(chunks: any[]): Record<string, any> {
  let merged: Record<string, any> = {}
  let hasObject = false
  let text = ''

  for (const chunk of chunks) {
    if (typeof chunk === 'string') {
      text += chunk
      continue
    }
    if (isPlainObject(chunk)) {
      merged = mergeToolInput(merged, chunk)
      hasObject = true
    }
  }

  const parsedText = parseToolInputText(text)
  if (parsedText) {
    merged = mergeToolInput(merged, parsedText)
    hasObject = true
  }

  return hasObject ? merged : {}
}

function parseToolInputText(text: string): Record<string, any> | undefined {
  if (!text.trim()) return undefined
  try {
    const parsed = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : undefined
  } catch {
    return parseConcatenatedToolInput(text)
  }
}

function parseConcatenatedToolInput(text: string): Record<string, any> | undefined {
  let merged: Record<string, any> = {}
  let found = false
  let cursor = 0

  while (cursor < text.length) {
    const start = text.indexOf('{', cursor)
    if (start === -1) break
    const end = findMatchingBrace(text, start)
    if (end === -1) break
    try {
      const parsed = JSON.parse(text.slice(start, end + 1))
      if (isPlainObject(parsed)) {
        merged = mergeToolInput(merged, parsed)
        found = true
      }
    } catch {
      // Ignore malformed fragments and keep scanning for later complete objects.
    }
    cursor = end + 1
  }

  return found ? merged : undefined
}

function mergeToolInput(
  target: Record<string, any>,
  patch: Record<string, any>
): Record<string, any> {
  const out: Record<string, any> = { ...target }
  for (const [key, value] of Object.entries(patch)) {
    const previous = out[key]
    if (isPlainObject(previous) && isPlainObject(value)) out[key] = mergeToolInput(previous, value)
    else if (typeof previous === 'string' && typeof value === 'string')
      out[key] = mergeStringFragment(previous, value)
    else out[key] = value
  }
  return out
}

function mergeStringFragment(previous: string, next: string): string {
  if (!previous) return next
  if (!next) return previous
  if (next.startsWith(previous)) return next
  if (previous.endsWith(next)) return previous
  return previous + next
}

function isPlainObject(value: any): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
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
