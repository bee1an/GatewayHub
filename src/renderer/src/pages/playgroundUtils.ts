/**
 * Playground 页面中的纯逻辑函数,脱离 React 生命周期以便单元测试。
 */

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  pending?: boolean
  error?: string
}

/**
 * 生成简短唯一的消息 ID。格式:base36 时间戳 + 6 位随机字符。
 */
export function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 重试逻辑:保留 targetId 之前的所有消息,丢弃该消息本身及其后的内容。
 * 如果 targetId 不存在则原样返回数组(安全兜底)。
 */
export function sliceBeforeMessage(messages: ChatMessage[], targetId: string): ChatMessage[] {
  const idx = messages.findIndex((m) => m.id === targetId)
  if (idx < 0) return messages
  return messages.slice(0, idx)
}

/**
 * 构建发送历史:清除所有失败消息,追加一条用户消息。
 */
export function prepareHistory(messages: ChatMessage[], userText: string): ChatMessage[] {
  const next: ChatMessage = { id: makeId(), role: 'user', content: userText }
  return [...messages.filter((m) => !m.error), next]
}

/**
 * 展平为 API 请求参数格式(去掉 pending/error 等 UI 状态)。
 */
export function flattenMessages(
  messages: ChatMessage[]
): { role: 'user' | 'assistant' | 'system'; content: string }[] {
  return messages.map((m) => ({ role: m.role, content: m.content }))
}
