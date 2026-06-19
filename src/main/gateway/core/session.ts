import type { IncomingHttpHeaders } from 'http'
import type { ApiKeyEntry, GatewayRequestContext } from '../types'
import { sha256Short } from './utils'

export type GatewaySessionSource = 'body' | 'metadata' | 'header' | 'fallback' | 'request'

export interface GatewaySessionInfo {
  id: string
  source: GatewaySessionSource
}

const METADATA_SESSION_KEYS = [
  'session_id',
  'sessionId',
  'claude_session_id',
  'claudeSessionId',
  'conversation_id',
  'conversationId',
  'thread_id',
  'threadId'
]

const BODY_SESSION_KEYS = [
  ...METADATA_SESSION_KEYS,
  'client_session_id',
  'clientSessionId',
  'chat_session_id',
  'chatSessionId'
]

const HEADER_SESSION_KEYS = [
  'x-claude-session-id',
  'x-session-id',
  'x-conversation-id',
  'x-thread-id',
  'x-codex-session-id',
  'anthropic-session-id'
]

export function deriveGatewaySession(
  headers: IncomingHttpHeaders,
  body: any,
  apiKeyEntry: ApiKeyEntry,
  requestId: string,
  apiFormat: GatewayRequestContext['apiFormat']
): GatewaySessionInfo {
  const metadataId = pickSessionString(body?.metadata, METADATA_SESSION_KEYS)
  if (metadataId) return { id: metadataId, source: 'metadata' }

  const bodyId = pickSessionString(body, BODY_SESSION_KEYS)
  if (bodyId) return { id: bodyId, source: 'body' }

  const headerId = pickHeaderSession(headers)
  if (headerId) return { id: headerId, source: 'header' }

  const fallbackId = deriveFallbackSessionId(body, apiKeyEntry, apiFormat)
  if (fallbackId) return { id: fallbackId, source: 'fallback' }

  return { id: requestId, source: 'request' }
}

function pickSessionString(input: unknown, keys: string[]): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  for (const key of keys) {
    const normalized = normalizeSessionString(record[key])
    if (normalized) return normalized
  }
  return undefined
}

function pickHeaderSession(headers: IncomingHttpHeaders): string | undefined {
  for (const key of HEADER_SESSION_KEYS) {
    const normalized = normalizeSessionString(headers[key])
    if (normalized) return normalized
  }
  return undefined
}

function normalizeSessionString(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string') return undefined
  // Strip ASCII control chars from upstream-supplied session IDs.
  // eslint-disable-next-line no-control-regex
  const trimmed = raw.trim().replace(/[\u0000-\u001f\u007f]/g, '')
  return trimmed ? trimmed.slice(0, 256) : undefined
}

function deriveFallbackSessionId(
  body: any,
  apiKeyEntry: ApiKeyEntry,
  apiFormat: GatewayRequestContext['apiFormat']
): string | undefined {
  const firstUserText = findFirstUserText(body?.messages)
  const systemText = extractSystemText(body)
  if (!firstUserText && !systemText) return undefined

  const keyScope = apiKeyEntry.id || sha256Short(apiKeyEntry.key || apiKeyEntry.name || 'default')
  return sha256Short(
    JSON.stringify({
      v: 1,
      apiFormat,
      keyScope,
      model: typeof body?.model === 'string' ? body.model : '',
      user: normalizeSessionString(body?.user) || '',
      firstUser: firstUserText ? sha256Short(firstUserText, 24) : '',
      system: systemText ? sha256Short(systemText, 16) : ''
    }),
    32
  )
}

function findFirstUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return ''
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const record = message as Record<string, unknown>
    if (record.role !== 'user') continue
    const text = contentToPlainText(record.content ?? record.contents).trim()
    if (text) return text
  }
  return ''
}

function extractSystemText(body: any): string {
  const direct = contentToPlainText(body?.system).trim()
  if (direct) return direct
  const messages = body?.messages
  if (!Array.isArray(messages)) return ''
  const parts: string[] = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const record = message as Record<string, unknown>
    if (record.role !== 'system') continue
    const text = contentToPlainText(record.content ?? record.contents).trim()
    if (text) parts.push(text)
  }
  return parts.join('\n\n')
}

function contentToPlainText(value: unknown, depth = 0): string {
  if (depth > 6 || value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => contentToPlainText(item, depth + 1))
      .filter(Boolean)
      .join('\n')
  }
  if (typeof value !== 'object') return ''

  const record = value as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  if (typeof record.input_text === 'string') return record.input_text
  if (record.content !== undefined) return contentToPlainText(record.content, depth + 1)
  if (record.contents !== undefined) return contentToPlainText(record.contents, depth + 1)
  return ''
}
