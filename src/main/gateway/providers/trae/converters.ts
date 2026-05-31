import { extractText } from '../kiro/converters'
import { normalizeTraeModel } from './constants'

export interface TraeMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
}

export function openAiToTraeMessages(body: any): TraeMessage[] {
  const messages = Array.isArray(body.messages) ? body.messages : []
  return messages
    .map((msg: any) => {
      const role = normalizeRole(msg?.role)
      const content = extractMessageText(msg?.content) || openAiToolCallsText(msg?.tool_calls)
      if (!role || !content) return undefined
      return { role, content, tool_call_id: msg?.tool_call_id } as TraeMessage
    })
    .filter(Boolean) as TraeMessage[]
}

export function anthropicToTraeMessages(body: any): TraeMessage[] {
  const out: TraeMessage[] = []
  const system = typeof body.system === 'string' ? body.system : extractText(body.system)
  if (system) out.push({ role: 'system', content: system })
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const msg of messages) {
    const role = msg?.role === 'assistant' ? 'assistant' : 'user'
    const content = anthropicContentText(msg?.content)
    if (content) out.push({ role, content })
  }
  return out
}

export function buildTraeRawChatPayload(
  model: string,
  body: any,
  format: 'openai' | 'anthropic'
): any {
  const normalizedModel = normalizeTraeModel(model)
  const messages = format === 'openai' ? openAiToTraeMessages(body) : anthropicToTraeMessages(body)
  const payload: any = {
    model: normalizedModel,
    model_name: normalizedModel,
    model_info: { model_name: normalizedModel, name: normalizedModel },
    messages,
    stream: true,
    max_tokens: body.max_tokens ?? body.max_completion_tokens,
    max_completion_tokens: body.max_completion_tokens ?? body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    pass_back_reasoning: true
  }

  // Trae app internals expose raw LLM request structs and function-scoped raw chat calls.
  // Keep the top-level request OpenAI-like, while also including the common wrapper fields
  // observed in the client binary. Unknown fields are ignored by tolerant schemas; if Trae
  // tightens validation, users can change rawChatPath/settings without touching GatewayHub API.
  payload.request = {
    model: normalizedModel,
    messages,
    stream: true,
    max_tokens: payload.max_tokens,
    max_completion_tokens: payload.max_completion_tokens,
    temperature: payload.temperature,
    top_p: payload.top_p
  }
  payload.raw_chat_function = 'chat'
  payload.function = 'chat'

  if (Array.isArray(body.tools) && body.tools.length) payload.tools = body.tools
  if (body.tool_choice !== undefined) payload.tool_choice = body.tool_choice
  if (body.reasoning_effort) payload.reasoning = { effort: body.reasoning_effort }
  else if (body.reasoning) payload.reasoning = body.reasoning

  return pruneUndefined(payload)
}

function normalizeRole(role: unknown): TraeMessage['role'] | undefined {
  if (
    role === 'system' ||
    role === 'developer' ||
    role === 'user' ||
    role === 'assistant' ||
    role === 'tool'
  ) {
    return role
  }
  return undefined
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

function anthropicContentText(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return extractText(content)
  const parts: string[] = []
  for (const block of content) {
    if (!block) continue
    if (block.type === 'text') parts.push(block.text || '')
    else if (block.type === 'image') parts.push('[image]')
    else if (block.type === 'tool_use') {
      parts.push(`[tool_use ${block.name || block.id || ''}] ${JSON.stringify(block.input ?? {})}`)
    } else if (block.type === 'tool_result') {
      parts.push(`[tool_result ${block.tool_use_id || ''}] ${extractText(block.content)}`)
    } else {
      parts.push(extractText(block))
    }
  }
  return parts.filter(Boolean).join('\n')
}

function openAiToolCallsText(value: any): string {
  return asArray(value)
    .map((toolCall) => {
      if (!toolCall || typeof toolCall !== 'object') return ''
      const name = toolCall.function?.name || toolCall.name || toolCall.id || ''
      const input = toolCall.function?.arguments ?? toolCall.arguments ?? toolCall.input ?? {}
      return `[tool_call ${name}] ${stringifyToolInput(input)}`
    })
    .filter(Boolean)
    .join('\n')
}

function asArray(value: any): any[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function stringifyToolInput(input: any): string {
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input ?? {})
  } catch {
    return String(input)
  }
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
