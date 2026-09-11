import { extractText } from '../kiro/converters'
import type { TraeWorkProviderSettings } from '../../types'
import { DEFAULT_TRAEWORK_FUNCTION, normalizeTraeWorkModel } from './constants'

export interface TraeWorkMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: Array<{ type: 'text'; text: string }>
  tool_calls?: TraeWorkMessageToolCall[]
  tool_call_id?: string
}

export interface TraeWorkMessageToolCall {
  index?: number
  id?: string
  type: 'function'
  function_call: { name: string; arguments: string }
}

/**
 * llm_utils_chat message shape: content is ALWAYS an array of
 * {type:'text',text} parts; assistant tool calls use `function_call` (not the
 * OpenAI `function` key); tool results ride as role:'tool' with content array.
 */
export function openAiToTraeWorkMessages(body: any): TraeWorkMessage[] {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const out: TraeWorkMessage[] = []
  for (const msg of messages) {
    const role = normalizeRole(msg?.role)
    if (!role) continue
    const text = extractMessageText(msg?.content)
    if (role === 'tool') {
      out.push({
        role: 'tool',
        content: textParts(text),
        tool_call_id: pickString(msg?.tool_call_id) || undefined
      })
      continue
    }
    const toolCalls = toUpstreamToolCalls(msg?.tool_calls)
    if (!text && !toolCalls) continue
    const converted: TraeWorkMessage = { role, content: textParts(text) }
    if (toolCalls) converted.tool_calls = toolCalls
    out.push(converted)
  }
  return out
}

export function anthropicToTraeWorkMessages(body: any): TraeWorkMessage[] {
  const out: TraeWorkMessage[] = []
  const system = typeof body.system === 'string' ? body.system : extractText(body.system)
  if (system) out.push({ role: 'system', content: textParts(system) })
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const msg of messages) {
    const role = msg?.role === 'assistant' ? 'assistant' : 'user'
    const textPartsOut: string[] = []
    const toolCalls: TraeWorkMessageToolCall[] = []
    for (const block of asArray(msg?.content)) {
      if (typeof block === 'string') {
        textPartsOut.push(block)
        continue
      }
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text') {
        if (block.text) textPartsOut.push(block.text)
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: pickString(block.id) || undefined,
          type: 'function',
          function_call: {
            name: pickString(block.name),
            arguments: stringifyArgs(block.input ?? {})
          }
        })
      } else if (block.type === 'tool_result') {
        // tool_result blocks live inside user messages upstream-wise they are
        // separate role:'tool' entries — flush any pending text first.
        if (textPartsOut.length) {
          out.push({ role: 'user', content: textParts(textPartsOut.join('\n')) })
          textPartsOut.length = 0
        }
        out.push({
          role: 'tool',
          content: textParts(anthropicToolResultText(block.content)),
          tool_call_id: pickString(block.tool_use_id) || undefined
        })
      } else if (block.type === 'image') {
        textPartsOut.push('[image]')
      }
    }
    const text = textPartsOut.filter(Boolean).join('\n')
    if (text || toolCalls.length) {
      const converted: TraeWorkMessage = { role, content: textParts(text) }
      if (toolCalls.length) converted.tool_calls = toolCalls
      out.push(converted)
    }
  }
  return out
}

/**
 * OpenAI/Anthropic tool definitions → upstream shape. The upstream Go struct
 * declares `function.parameters` as a string field, so the JSON schema must be
 * serialized, not embedded as an object.
 */
export function buildTraeWorkTools(body: any, format: 'openai' | 'anthropic'): any[] | undefined {
  const rawTools = Array.isArray(body.tools) ? body.tools : []
  const tools: any[] = []
  for (const tool of rawTools) {
    if (!tool || typeof tool !== 'object') continue
    const fn = format === 'openai' ? tool.function || tool : tool
    const name = pickString(fn?.name, tool.name)
    if (!name) continue
    const schema = fn?.parameters ?? tool.input_schema ?? tool.parameters ?? {}
    tools.push({
      type: 'function',
      function: {
        name,
        description: pickString(fn?.description, tool.description),
        parameters: stringifyArgs(schema)
      }
    })
  }
  return tools.length ? tools : undefined
}

export function buildTraeWorkChatPayload(
  model: string,
  body: any,
  format: 'openai' | 'anthropic',
  settings?: Pick<TraeWorkProviderSettings, 'function'>
): any {
  const configName = normalizeTraeWorkModel(model)
  const messages =
    format === 'openai' ? openAiToTraeWorkMessages(body) : anthropicToTraeWorkMessages(body)
  const payload: any = {
    messages,
    function: settings?.function || DEFAULT_TRAEWORK_FUNCTION,
    stream: true,
    config_name: configName,
    model: configName,
    max_tokens: body.max_tokens ?? body.max_completion_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    presence_penalty: body.presence_penalty,
    frequency_penalty: body.frequency_penalty,
    stop: body.stop ?? body.stop_sequences,
    seed: body.seed,
    n: body.n
  }
  const tools = buildTraeWorkTools(body, format)
  if (tools) payload.tools = tools
  return pruneUndefined(payload)
}

function normalizeRole(role: unknown): TraeWorkMessage['role'] | undefined {
  if (role === 'system' || role === 'developer') return 'system'
  if (role === 'user' || role === 'assistant' || role === 'tool') return role
  return undefined
}

function textParts(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: text || '' }]
}

function toUpstreamToolCalls(value: any): TraeWorkMessageToolCall[] | undefined {
  const items = asArray(value)
  if (!items.length) return undefined
  const out: TraeWorkMessageToolCall[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item || typeof item !== 'object') continue
    const name = pickString(item.function_call?.name, item.function?.name, item.name)
    if (!name) continue
    const args = item.function_call?.arguments ?? item.function?.arguments ?? item.arguments ?? {}
    out.push({
      index: typeof item.index === 'number' ? item.index : i,
      id: pickString(item.id, item.tool_call_id) || undefined,
      type: 'function',
      function_call: { name, arguments: stringifyArgs(args) }
    })
  }
  return out.length ? out : undefined
}

function extractMessageText(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part?.type === 'text') return part.text || ''
        if (part?.type === 'input_text') return part.text || ''
        if (part?.type === 'image_url') return '[image]'
        if (part?.type === 'image') return '[image]'
        return extractText(part)
      })
      .filter(Boolean)
      .join('\n')
  }
  return extractText(content)
}

function anthropicToolResultText(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block
        if (block?.type === 'text') return block.text || ''
        return extractText(block)
      })
      .filter(Boolean)
      .join('\n')
  }
  return extractText(content)
}

function stringifyArgs(value: any): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

function asArray(value: any): any[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return ''
}

function pruneUndefined<T>(value: T): T {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(pruneUndefined) as T
  const out: any = {}
  for (const [key, item] of Object.entries(value as any)) {
    if (item === undefined) continue
    out[key] = pruneUndefined(item)
  }
  return out
}
