import { randomUUID } from 'crypto'

export interface GatewayToolCall {
  id?: string
  name: string
  input: any
}

export function splitInlineToolCalls(text: string): { text: string; toolCalls: GatewayToolCall[] } {
  const toolCalls: GatewayToolCall[] = []
  const cleaned = text.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi, (_match, raw) => {
    toolCalls.push(...normalizeInlineToolCalls(raw))
    return ''
  })
  return { text: cleaned.trim(), toolCalls: dedupeToolCalls(toolCalls) }
}

export function normalizeGatewayToolCalls(values: any[]): GatewayToolCall[] {
  return dedupeToolCalls(values.flatMap((value, index) => normalizeGatewayToolCall(value, index)))
}

export function normalizeGatewayToolCall(value: any, index = 0): GatewayToolCall[] {
  if (!value) return []
  if (Array.isArray(value)) return value.flatMap((item, i) => normalizeGatewayToolCall(item, i))
  if (typeof value === 'string') return normalizeInlineToolCalls(value)
  if (typeof value !== 'object') return []

  const nested = Array.isArray(value.tool_calls)
    ? value.tool_calls
    : Array.isArray(value.toolCalls)
      ? value.toolCalls
      : undefined
  if (nested) return nested.flatMap((item: any, i: number) => normalizeGatewayToolCall(item, i))

  const fn = value.function || value.tool || value
  const name =
    pickString(fn.name, value.name, value.tool_name, value.toolName, value.function_name) ||
    `tool_${index + 1}`
  const rawInput =
    fn.arguments ??
    fn.arguments_json ??
    fn.argumentsJson ??
    value.arguments ??
    value.arguments_json ??
    value.argumentsJson ??
    value.input ??
    value.parameters ??
    {}
  return [
    {
      id: pickString(value.id, value.tool_call_id, value.toolCallId, value.call_id, value.callId),
      name,
      input: normalizeToolInput(rawInput)
    }
  ]
}

export function toOpenAiToolCalls(toolCalls: GatewayToolCall[]): any[] {
  return toolCalls.map((toolCall, index) => ({
    index,
    id: toolCall.id || `call_${randomUUID().replace(/-/g, '')}`,
    type: 'function',
    function: {
      name: toolCall.name,
      arguments: stringifyToolInput(toolCall.input)
    }
  }))
}

export function toAnthropicContentBlocks(text: string, toolCalls?: GatewayToolCall[]): any[] {
  const blocks: any[] = []
  if (text) blocks.push({ type: 'text', text })
  for (const toolCall of toolCalls || []) {
    blocks.push({
      type: 'tool_use',
      id: toolCall.id || `toolu_${randomUUID().replace(/-/g, '')}`,
      name: toolCall.name,
      input: normalizeToolInput(toolCall.input)
    })
  }
  if (!blocks.length) blocks.push({ type: 'text', text: '' })
  return blocks
}

export function normalizeToolInput(input: any): any {
  if (!input) return {}
  if (typeof input === 'object') return input
  if (typeof input === 'string') {
    try {
      return JSON.parse(input)
    } catch {
      return { arguments: input }
    }
  }
  return { value: input }
}

export function stringifyToolInput(input: any): string {
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(normalizeToolInput(input))
  } catch {
    return '{}'
  }
}

export function dedupeToolCalls(toolCalls: GatewayToolCall[]): GatewayToolCall[] {
  const seen = new Set<string>()
  const result: GatewayToolCall[] = []
  for (const call of toolCalls) {
    if (!call.name) continue
    const key = `${call.id || ''}\0${call.name}\0${stringifyToolInput(call.input)}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(call)
  }
  return result
}

function normalizeInlineToolCalls(raw: string): GatewayToolCall[] {
  const trimmed = raw.trim()
  if (!trimmed) return []
  const parsed = parseJsonObject(trimmed)
  if (parsed !== undefined) return normalizeGatewayToolCall(parsed)
  const nameMatch =
    trimmed.match(/(?:^|\n)\s*(?:name|tool_name|toolName)\s*[:=]\s*([A-Za-z0-9_.:-]+)/) ||
    trimmed.match(/^\s*([A-Za-z0-9_.:-]+)\s*(?:\n|$)/)
  const argsMatch = trimmed.match(/(?:arguments|input)\s*[:=]\s*([\s\S]+)$/)
  if (!nameMatch) return []
  return [
    {
      name: nameMatch[1],
      input: normalizeToolInput(argsMatch?.[1]?.trim() || {})
    }
  ]
}

function parseJsonObject(value: string): any | undefined {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}
