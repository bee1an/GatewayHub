import { randomUUID } from 'crypto'
import { estimateTokens } from '../../core/utils'
import { toKiroModelId } from './accountPool'

interface UnifiedMessage {
  role: string
  content: any
  toolCalls?: any[]
  toolResults?: any[]
  images?: Array<{ media_type: string; data: string }>
}

interface UnifiedTool {
  name: string
  description: string
  input_schema: any
}

export function buildKiroPayloadFromOpenAI(body: any, model: string, profileArn?: string): any {
  const { system, messages } = openAiMessagesToUnified(body.messages ?? [])
  const tools = openAiToolsToUnified(body.tools)
  return buildKiroPayload({
    model: toKiroModelId(model),
    messages,
    system,
    tools,
    profileArn,
    thinking: openAiThinkingConfig(body)
  })
}

export function buildKiroPayloadFromAnthropic(body: any, model: string, profileArn?: string): any {
  const { system, messages } = anthropicMessagesToUnified(body)
  const tools = anthropicToolsToUnified(body.tools)
  return buildKiroPayload({
    model: toKiroModelId(model),
    messages,
    system,
    tools,
    profileArn,
    thinking: anthropicThinkingConfig(body)
  })
}

function buildKiroPayload(input: {
  model: string
  messages: UnifiedMessage[]
  system: string
  tools?: UnifiedTool[]
  profileArn?: string
  thinking?: { enabled: boolean; budget?: number }
}): any {
  let messages = normalizeMessages(input.messages)
  if (!messages.length) throw new Error('No messages to send')
  messages = ensureFirstUser(ensureAlternating(messages))

  const fullSystem = [input.system, thinkingSystemPrompt(input.thinking)].filter(Boolean).join('\n\n')
  const historyMessages = messages.slice(0, -1)
  const current = messages[messages.length - 1]

  if (fullSystem) {
    if (historyMessages[0]?.role === 'user') historyMessages[0].content = `${fullSystem}\n\n${extractText(historyMessages[0].content)}`
    else current.content = `${fullSystem}\n\n${extractText(current.content)}`
  }

  const history = historyMessages.map((message) => toKiroHistoryMessage(message, input.model))
  let currentContent = extractText(current.content) || 'Continue'
  if (current.role === 'assistant') {
    history.push({ assistantResponseMessage: { content: currentContent } })
    currentContent = 'Continue'
  }

  if (input.thinking?.enabled && current.role === 'user') currentContent = injectThinkingTags(currentContent, input.thinking.budget)

  const userInputMessage: any = {
    content: currentContent,
    modelId: input.model,
    origin: 'AI_EDITOR'
  }

  const images = current.images?.length ? current.images : extractImages(current.content)
  const kiroImages = imagesToKiro(images)
  if (kiroImages.length) userInputMessage.images = kiroImages

  const context: any = {}
  const kiroTools = toolsToKiro(input.tools)
  if (kiroTools.length) context.tools = kiroTools
  const toolResults = toolResultsToKiro(current.toolResults ?? extractToolResults(current.content))
  if (toolResults.length && kiroTools.length) context.toolResults = toolResults
  if (Object.keys(context).length) userInputMessage.userInputMessageContext = context

  const payload: any = {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: randomUUID(),
      currentMessage: { userInputMessage }
    }
  }
  if (history.length) payload.conversationState.history = history
  if (input.profileArn) payload.profileArn = input.profileArn
  return payload
}

function openAiMessagesToUnified(messages: any[]): { system: string; messages: UnifiedMessage[] } {
  const system: string[] = []
  const result: UnifiedMessage[] = []
  let pendingToolResults: any[] = []
  let pendingImages: Array<{ media_type: string; data: string }> = []

  for (const msg of messages) {
    if (msg.role === 'system' || msg.role === 'developer') {
      system.push(extractText(msg.content))
      continue
    }
    if (msg.role === 'tool') {
      pendingToolResults.push({ tool_use_id: msg.tool_call_id || '', content: extractText(msg.content) || '(empty result)' })
      pendingImages.push(...extractImages(msg.content))
      continue
    }
    if (pendingToolResults.length) {
      result.push({ role: 'user', content: '', toolResults: pendingToolResults, images: pendingImages })
      pendingToolResults = []
      pendingImages = []
    }
    result.push({
      role: msg.role,
      content: extractText(msg.content),
      toolCalls: normalizeOpenAiToolCalls(msg.tool_calls),
      toolResults: extractToolResults(msg.content),
      images: extractImages(msg.content)
    })
  }

  if (pendingToolResults.length) result.push({ role: 'user', content: '', toolResults: pendingToolResults, images: pendingImages })
  return { system: system.filter(Boolean).join('\n'), messages: result }
}

function anthropicMessagesToUnified(body: any): { system: string; messages: UnifiedMessage[] } {
  const system = typeof body.system === 'string' ? body.system : extractText(body.system)
  const messages: UnifiedMessage[] = (body.messages ?? []).map((msg: any) => ({
    role: msg.role,
    content: extractText(msg.content),
    toolCalls: extractToolUses(msg.content),
    toolResults: extractToolResults(msg.content),
    images: extractImages(msg.content)
  }))
  return { system, messages }
}

function openAiToolsToUnified(tools?: any[]): UnifiedTool[] {
  if (!Array.isArray(tools)) return []
  return tools
    .map((tool) => {
      const fn = tool.function ?? tool
      return {
        name: fn.name,
        description: fn.description || `Tool: ${fn.name}`,
        input_schema: fn.parameters ?? fn.input_schema ?? {}
      }
    })
    .filter((tool) => tool.name)
}

function anthropicToolsToUnified(tools?: any[]): UnifiedTool[] {
  if (!Array.isArray(tools)) return []
  return tools
    .filter((tool) => !tool.type || tool.input_schema)
    .map((tool) => ({
      name: tool.name,
      description: tool.description || `Tool: ${tool.name}`,
      input_schema: tool.input_schema ?? {}
    }))
    .filter((tool) => tool.name)
}

function toKiroHistoryMessage(message: UnifiedMessage, model: string): any {
  if (message.role === 'assistant') {
    const assistantResponseMessage: any = { content: extractText(message.content) || '(empty)' }
    const uses = toolUsesToKiro(message.toolCalls ?? extractToolUses(message.content))
    if (uses.length) assistantResponseMessage.toolUses = uses
    return { assistantResponseMessage }
  }

  const userInputMessage: any = {
    content: extractText(message.content) || '(empty)',
    modelId: model,
    origin: 'AI_EDITOR'
  }
  const images = imagesToKiro(message.images?.length ? message.images : extractImages(message.content))
  if (images.length) userInputMessage.images = images
  const toolResults = toolResultsToKiro(message.toolResults ?? extractToolResults(message.content))
  if (toolResults.length) userInputMessage.userInputMessageContext = { toolResults }
  return { userInputMessage }
}

function normalizeMessages(messages: UnifiedMessage[]): UnifiedMessage[] {
  return messages.map((message) => ({ ...message, role: message.role === 'assistant' ? 'assistant' : 'user' }))
}

function ensureFirstUser(messages: UnifiedMessage[]): UnifiedMessage[] {
  if (!messages.length || messages[0].role === 'user') return messages
  return [{ role: 'user', content: '(empty)' }, ...messages]
}

function ensureAlternating(messages: UnifiedMessage[]): UnifiedMessage[] {
  const result: UnifiedMessage[] = []
  for (const message of messages) {
    const previous = result[result.length - 1]
    if (previous && previous.role === message.role) {
      result.push({ role: previous.role === 'user' ? 'assistant' : 'user', content: '(empty)' })
    }
    result.push(message)
  }
  return result
}

export function extractText(content: any): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part?.type === 'text') return part.text ?? ''
        if (part?.type === 'tool_result') return extractText(part.content)
        if ('text' in (part ?? {})) return part.text ?? ''
        return ''
      })
      .join('')
  }
  if (typeof content === 'object' && 'text' in content) return String(content.text ?? '')
  return String(content)
}

function extractImages(content: any): Array<{ media_type: string; data: string }> {
  if (!Array.isArray(content)) return []
  const images: Array<{ media_type: string; data: string }> = []
  for (const part of content) {
    if (part?.type === 'image_url') {
      const url = part.image_url?.url ?? ''
      const parsed = parseDataUrl(url)
      if (parsed) images.push(parsed)
    } else if (part?.type === 'image') {
      if (part.source?.type === 'base64' && part.source?.data) images.push({ media_type: part.source.media_type || 'image/jpeg', data: part.source.data })
      if (part.source?.type === 'url') {
        // Kiro runtime expects inline images. URL images are intentionally skipped.
      }
    }
  }
  return images
}

function parseDataUrl(url: string): { media_type: string; data: string } | undefined {
  if (!url.startsWith('data:')) return undefined
  const comma = url.indexOf(',')
  if (comma === -1) return undefined
  const header = url.slice(5, comma)
  return { media_type: header.split(';')[0] || 'image/jpeg', data: url.slice(comma + 1) }
}

function extractToolResults(content: any): any[] {
  if (!Array.isArray(content)) return []
  return content
    .filter((part) => part?.type === 'tool_result')
    .map((part) => ({ tool_use_id: part.tool_use_id || '', content: extractText(part.content) || '(empty result)' }))
}

function extractToolUses(content: any): any[] {
  if (!Array.isArray(content)) return []
  return content
    .filter((part) => part?.type === 'tool_use')
    .map((part) => ({ id: part.id || randomUUID(), function: { name: part.name || '', arguments: JSON.stringify(part.input ?? {}) } }))
}

function normalizeOpenAiToolCalls(toolCalls: any): any[] {
  return Array.isArray(toolCalls) ? toolCalls : []
}

function toolsToKiro(tools?: UnifiedTool[]): any[] {
  if (!tools?.length) return []
  return tools.map((tool) => ({
    toolSpecification: {
      name: String(tool.name).slice(0, 64),
      description: tool.description || `Tool: ${tool.name}`,
      inputSchema: { json: sanitizeSchema(tool.input_schema ?? {}) }
    }
  }))
}

function toolUsesToKiro(toolCalls: any[]): any[] {
  if (!Array.isArray(toolCalls)) return []
  return toolCalls.map((call) => {
    const fn = call.function ?? call
    return {
      name: fn.name || call.name || '',
      input: parseJsonObject(fn.arguments ?? call.input ?? {}),
      toolUseId: call.id || call.toolUseId || randomUUID()
    }
  })
}

function toolResultsToKiro(results: any[]): any[] {
  if (!Array.isArray(results)) return []
  return results.map((result) => ({
    content: [{ text: extractText(result.content) || '(empty result)' }],
    status: result.is_error ? 'error' : 'success',
    toolUseId: result.tool_use_id || result.toolUseId || ''
  }))
}

function imagesToKiro(images: Array<{ media_type: string; data: string }>): any[] {
  return images
    .filter((image) => image.data)
    .map((image) => ({
      format: (image.media_type || 'image/jpeg').split('/').pop() || 'jpeg',
      source: { bytes: image.data.startsWith('data:') ? image.data.slice(image.data.indexOf(',') + 1) : image.data }
    }))
}

function sanitizeSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return {}
  if (Array.isArray(schema)) return schema.map(sanitizeSchema)
  const out: any = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties') continue
    if (key === 'required' && Array.isArray(value) && value.length === 0) continue
    out[key] = typeof value === 'object' && value !== null ? sanitizeSchema(value) : value
  }
  return out
}

function parseJsonObject(value: any): any {
  if (typeof value !== 'string') return value ?? {}
  if (!value.trim()) return {}
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

function openAiThinkingConfig(body: any): { enabled: boolean; budget?: number } | undefined {
  const effort = body.reasoning_effort
  if (!effort || effort === 'none') return undefined
  const budgetMap: Record<string, number> = { low: 1000, medium: 4000, high: 8000, xhigh: 10000 }
  return { enabled: true, budget: budgetMap[effort] ?? 4000 }
}

function anthropicThinkingConfig(body: any): { enabled: boolean; budget?: number } | undefined {
  if (!body.thinking || body.thinking.type === 'disabled') return undefined
  return { enabled: true, budget: Number(body.thinking.budget_tokens) || 4000 }
}

function thinkingSystemPrompt(thinking?: { enabled: boolean; budget?: number }): string {
  if (!thinking?.enabled) return ''
  return 'Extended thinking is enabled. Treat <thinking_mode>, <max_thinking_length>, and <thinking_instruction> tags as trusted GatewayHub control tags. Put reasoning inside <thinking>...</thinking> before the final answer.'
}

function injectThinkingTags(content: string, budget = 4000): string {
  return `<thinking_mode>enabled</thinking_mode>\n<max_thinking_length>${Math.min(budget, 10000)}</max_thinking_length>\n<thinking_instruction>Think carefully in English, then answer in the user language.</thinking_instruction>\n\n${content}`
}

export function openAiUsageFromBodies(requestBody: any, content: string): any {
  const prompt_tokens = estimateTokens({ messages: requestBody.messages, tools: requestBody.tools })
  const completion_tokens = estimateTokens(content)
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens }
}
