import { extractText } from '../kiro/converters'
import { normalizeCodexModel } from './constants'

/**
 * 把 OpenAI Chat Completions 请求体转成 Responses API payload。
 * 由于 GptWeb 后端 /codex/responses 只接受 Responses 协议（不接受 chat/completions），
 * 我们必须先把 messages 折叠为 instructions + input。
 */
export function chatToResponsesPayload(body: any): any {
  const messages: any[] = Array.isArray(body.messages) ? body.messages : []
  const systemTexts: string[] = []
  const input: any[] = []
  for (const msg of messages) {
    if (msg.role === 'system' || msg.role === 'developer') {
      const text = extractText(msg.content)
      if (text) systemTexts.push(text)
      continue
    }
    if (msg.role === 'tool') {
      // Convert tool results to function_call_output items
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id ?? '',
        output: typeof msg.content === 'string' ? msg.content : extractText(msg.content)
      })
      continue
    }
    if (msg.role === 'assistant') {
      // Handle assistant messages with tool_calls
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        // First emit any text content
        const text = extractText(msg.content)
        if (text) {
          input.push({ role: 'assistant', content: [{ type: 'input_text', text }] })
        }
        // Then emit each tool call as a function_call input item
        for (const tc of msg.tool_calls) {
          input.push({
            type: 'function_call',
            call_id: tc.id ?? '',
            name: tc.function?.name ?? '',
            arguments: tc.function?.arguments ?? '{}'
          })
        }
        continue
      }
      const content = convertContentItems(msg.content)
      input.push({ role: 'assistant', content })
      continue
    }
    if (msg.role !== 'user') continue
    const content = convertContentItems(msg.content)
    input.push({ role: 'user', content })
  }

  const payload: any = {
    model: normalizeCodexModel(String(body.model || 'gpt-5')),
    instructions: systemTexts.join('\n') || 'You are a helpful assistant.',
    input,
    store: false,
    stream: true
  }

  // Tools support
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    payload.tools = body.tools.map((tool: any) => {
      if (tool.type === 'function' && tool.function) {
        return {
          type: 'function',
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters
        }
      }
      return tool
    })
  }

  // Tool choice
  if (body.tool_choice !== undefined) {
    payload.tool_choice = body.tool_choice
  }

  // Reasoning effort
  if (body.reasoning_effort) {
    payload.reasoning = { effort: body.reasoning_effort }
  } else if (body.reasoning?.effort) {
    payload.reasoning = { effort: body.reasoning.effort }
  }

  return payload
}

/**
 * Anthropic /v1/messages 请求体 → Responses API payload。
 */
export function anthropicToResponsesPayload(body: any): any {
  const system = typeof body.system === 'string' ? body.system : extractText(body.system)
  const messages: any[] = Array.isArray(body.messages) ? body.messages : []
  const input: any[] = []
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      // Handle assistant messages with tool_use blocks
      if (Array.isArray(msg.content)) {
        const hasToolUse = msg.content.some((b: any) => b.type === 'tool_use')
        if (hasToolUse) {
          // Emit text content first
          const textBlocks = msg.content.filter((b: any) => b.type === 'text')
          const text = textBlocks.map((b: any) => b.text || '').join('')
          if (text) {
            input.push({ role: 'assistant', content: [{ type: 'input_text', text }] })
          }
          // Emit each tool_use as function_call
          for (const block of msg.content) {
            if (block.type === 'tool_use') {
              input.push({
                type: 'function_call',
                call_id: block.id ?? '',
                name: block.name ?? '',
                arguments:
                  typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {})
              })
            }
          }
          continue
        }
      }
      const content = convertAnthropicContent(msg.content)
      input.push({ role: 'assistant', content })
      continue
    }
    if (msg.role === 'user') {
      // Handle user messages with tool_result blocks
      if (Array.isArray(msg.content)) {
        const hasToolResult = msg.content.some((b: any) => b.type === 'tool_result')
        if (hasToolResult) {
          for (const block of msg.content) {
            if (block.type === 'tool_result') {
              const output =
                typeof block.content === 'string' ? block.content : extractText(block.content)
              input.push({
                type: 'function_call_output',
                call_id: block.tool_use_id ?? '',
                output: output || ''
              })
            } else if (block.type === 'text') {
              input.push({
                role: 'user',
                content: [{ type: 'input_text', text: block.text || '' }]
              })
            } else if (block.type === 'image') {
              const content = convertAnthropicContent([block])
              input.push({ role: 'user', content })
            }
          }
          continue
        }
      }
      const content = convertAnthropicContent(msg.content)
      input.push({ role: 'user', content })
      continue
    }
    // Fallback for other roles
    const content = convertAnthropicContent(msg.content)
    input.push({ role: 'user', content })
  }

  const payload: any = {
    model: normalizeCodexModel(String(body.model || 'gpt-5')),
    instructions: system || 'You are a helpful assistant.',
    input,
    store: false,
    stream: true,
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === 'number' ? { top_p: body.top_p } : {})
  }

  // Tools support (Anthropic format)
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    payload.tools = body.tools.map((tool: any) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema
    }))
  }

  // Tool choice (Anthropic format)
  if (body.tool_choice) {
    if (body.tool_choice.type === 'auto') payload.tool_choice = 'auto'
    else if (body.tool_choice.type === 'any') payload.tool_choice = 'required'
    else if (body.tool_choice.type === 'tool') payload.tool_choice = body.tool_choice.name
    else payload.tool_choice = body.tool_choice
  }

  // Reasoning effort (Anthropic thinking → reasoning)
  if (body.thinking?.budget_tokens) {
    payload.reasoning = { effort: 'high' }
  }

  return payload
}

/**
 * Convert OpenAI message content (string or array) to Responses API content items.
 * Handles text and image_url content parts.
 */
function convertContentItems(content: any): any[] {
  if (typeof content === 'string') {
    return [{ type: 'input_text', text: content }]
  }
  if (!Array.isArray(content)) {
    return [{ type: 'input_text', text: extractText(content) }]
  }
  const items: any[] = []
  for (const part of content) {
    if (part.type === 'text') {
      items.push({ type: 'input_text', text: part.text || '' })
    } else if (part.type === 'image_url' && part.image_url) {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url.url
      if (url) {
        items.push({ type: 'input_image', image_url: url })
      }
    } else {
      // Fallback: try to extract text
      const text = extractText(part)
      if (text) items.push({ type: 'input_text', text })
    }
  }
  return items.length ? items : [{ type: 'input_text', text: '' }]
}

/**
 * Convert Anthropic message content (string or array of blocks) to Responses API content items.
 * Handles text and image (base64) content blocks.
 */
function convertAnthropicContent(content: any): any[] {
  if (typeof content === 'string') {
    return [{ type: 'input_text', text: content }]
  }
  if (!Array.isArray(content)) {
    return [{ type: 'input_text', text: extractText(content) }]
  }
  const items: any[] = []
  for (const block of content) {
    if (block.type === 'text') {
      items.push({ type: 'input_text', text: block.text || '' })
    } else if (block.type === 'image') {
      // Anthropic base64 image: { type: 'image', source: { type: 'base64', media_type, data } }
      const source = block.source
      if (source?.type === 'base64' && source.data) {
        const dataUrl = `data:${source.media_type || 'image/png'};base64,${source.data}`
        items.push({ type: 'input_image', image_url: dataUrl })
      } else if (source?.type === 'url' && source.url) {
        items.push({ type: 'input_image', image_url: source.url })
      }
    } else {
      const text = extractText(block)
      if (text) items.push({ type: 'input_text', text })
    }
  }
  return items.length ? items : [{ type: 'input_text', text: '' }]
}
