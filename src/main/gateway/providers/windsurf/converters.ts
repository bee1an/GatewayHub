import { extractText } from '../kiro/converters'

export interface WindsurfPromptPayload {
  prompt: string
}

export function openAiToWindsurfPrompt(body: any): WindsurfPromptPayload {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const lines: string[] = []
  for (const msg of messages) {
    const role = msg?.role
    const text = extractText(msg?.content)
    if (role === 'system' || role === 'developer') {
      if (text) lines.push(`System: ${text}`)
    } else if (role === 'assistant') {
      if (text) lines.push(`Assistant: ${text}`)
      appendOpenAiToolCalls(lines, msg)
    } else if (role === 'tool') {
      lines.push(`Tool result${msg.tool_call_id ? ` ${msg.tool_call_id}` : ''}: ${text}`)
    } else if (text) {
      lines.push(`User: ${text}`)
    }
  }
  return { prompt: lines.join('\n\n') }
}

export function anthropicToWindsurfPrompt(body: any): WindsurfPromptPayload {
  const system = typeof body.system === 'string' ? body.system : extractText(body.system)
  const messages = Array.isArray(body.messages) ? body.messages : []
  const lines = system ? [`System: ${system}`] : []
  for (const msg of messages) {
    const role = msg?.role === 'assistant' ? 'Assistant' : 'User'
    const blocks = Array.isArray(msg?.content) ? msg.content : undefined
    if (!blocks) {
      const text = extractText(msg?.content)
      if (text) lines.push(`${role}: ${text}`)
      continue
    }
    appendAnthropicBlocks(lines, role, blocks)
  }
  return { prompt: lines.join('\n\n') }
}

function appendOpenAiToolCalls(lines: string[], msg: any): void {
  const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : []
  for (const call of toolCalls) {
    const name = call?.function?.name || call?.name || 'tool'
    const args = call?.function?.arguments || call?.arguments || '{}'
    lines.push(`Assistant tool call ${name}: ${args}`)
  }
}

function appendAnthropicBlocks(lines: string[], role: string, blocks: any[]): void {
  for (const block of blocks) {
    if (block?.type === 'text' && block.text) {
      lines.push(`${role}: ${block.text}`)
    } else if (block?.type === 'tool_use') {
      lines.push(
        `Assistant tool call ${block.name || 'tool'}: ${JSON.stringify(block.input || {})}`
      )
    } else if (block?.type === 'tool_result') {
      const content = typeof block.content === 'string' ? block.content : extractText(block.content)
      lines.push(`Tool result ${block.tool_use_id || ''}: ${content}`)
    }
  }
}
