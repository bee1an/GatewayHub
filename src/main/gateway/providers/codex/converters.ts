import { extractText } from '../kiro/converters'
import { normalizeCodexModel } from './constants'

/**
 * 把 OpenAI Chat Completions 请求体转成 Responses API payload。
 * 由于 ChatGPT 后端 /codex/responses 只接受 Responses 协议（不接受 chat/completions），
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
      // Codex Responses API 没有原生的 chat tool 角色概念；用 user input_text 把 tool 结果传进去
      const text = `[tool_result tool_call_id=${msg.tool_call_id ?? ''}]\n${extractText(msg.content)}`
      input.push({ role: 'user', content: [{ type: 'input_text', text }] })
      continue
    }
    if (msg.role !== 'assistant' && msg.role !== 'user') continue
    const text = extractText(msg.content)
    input.push({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: 'input_text', text }]
    })
  }
  return {
    model: normalizeCodexModel(String(body.model || 'gpt-5')),
    instructions: systemTexts.join('\n') || 'You are a helpful assistant.',
    input,
    store: false,
    stream: true
  }
}

/**
 * Anthropic /v1/messages 请求体 → Responses API payload。
 */
export function anthropicToResponsesPayload(body: any): any {
  const system = typeof body.system === 'string' ? body.system : extractText(body.system)
  const messages: any[] = Array.isArray(body.messages) ? body.messages : []
  const input: any[] = []
  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'assistant' : 'user'
    const text = extractText(msg.content)
    input.push({ role, content: [{ type: 'input_text', text }] })
  }
  return {
    model: normalizeCodexModel(String(body.model || 'gpt-5')),
    instructions: system || 'You are a helpful assistant.',
    input,
    store: false,
    stream: true,
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === 'number' ? { top_p: body.top_p } : {})
  }
}
