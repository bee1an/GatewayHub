import { createHash, randomBytes, randomUUID } from 'crypto'
import type { CodexAccountConfig } from '../../types'
import { sha256Short } from '../../core/utils'
import type { CodexAuthPayload, CodexAccountInfo, CodexTokenResponse } from './types'

/** base64url decode（不依赖 padding） */
function base64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4))
  return Buffer.from(normalized + pad, 'base64').toString('utf8')
}

/** 解析 JWT 第二段为 payload；不验证签名 */
export function decodeJwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  if (!token || typeof token !== 'string') return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    return JSON.parse(base64UrlDecode(parts[1]))
  } catch {
    return undefined
  }
}

const OAI_AUTH_NS = 'https://api.openai.com/auth.'
const OAI_PROFILE_NS = 'https://api.openai.com/profile.'

function pickClaim(claims: Record<string, unknown>, prefix: string, key: string): unknown {
  return claims[`${prefix}${key}`] ?? claims[key]
}

export function resolveChatGptAccountId(
  tokens: { access_token?: string; id_token?: string; account_id?: string } | undefined
): string | undefined {
  if (!tokens) return undefined
  if (tokens.account_id) return tokens.account_id
  for (const tok of [tokens.id_token, tokens.access_token]) {
    const claims = decodeJwtPayload(tok)
    if (!claims) continue
    const fromAuth = pickClaim(claims, OAI_AUTH_NS, 'chatgpt_account_id')
    if (typeof fromAuth === 'string' && fromAuth) return fromAuth
  }
  return undefined
}

export function resolveSubscriptionActiveUntil(
  tokens: { id_token?: string } | undefined
): string | undefined {
  if (!tokens?.id_token) return undefined
  const claims = decodeJwtPayload(tokens.id_token)
  if (!claims) return undefined
  const v = pickClaim(claims, OAI_AUTH_NS, 'chatgpt_subscription_active_until')
  if (typeof v === 'string' && v) return v
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v * 1000).toISOString()
  return undefined
}

export function resolveAccessTokenExpiry(accessToken: string | undefined): number | undefined {
  const claims = decodeJwtPayload(accessToken)
  const exp = claims?.exp
  if (typeof exp === 'number' && Number.isFinite(exp)) return exp * 1000
  return undefined
}

export function resolveProfileFromTokens(
  tokens: { id_token?: string; access_token?: string } | undefined
): { email?: string; name?: string; sub?: string } {
  for (const tok of [tokens?.id_token, tokens?.access_token]) {
    const claims = decodeJwtPayload(tok)
    if (!claims) continue
    const email =
      (pickClaim(claims, OAI_PROFILE_NS, 'email') as string | undefined) ||
      (claims.email as string | undefined)
    const name =
      (pickClaim(claims, OAI_PROFILE_NS, 'name') as string | undefined) ||
      (claims.name as string | undefined)
    const sub = (claims.sub as string | undefined) || undefined
    if (email || name || sub) return { email, name, sub }
  }
  return {}
}

/** 把 auth.json 风格的 payload 归一化为我们持久化的 CodexAccountConfig */
export function buildCodexAccountFromAuth(
  auth: CodexAuthPayload,
  options?: { label?: string }
): CodexAccountConfig | null {
  const tokens = auth.tokens
  const refreshToken = tokens?.refresh_token
  const accessToken = tokens?.access_token
  if (!refreshToken && !accessToken) return null

  const profile = resolveProfileFromTokens(tokens)
  const chatgptAccountId = resolveChatGptAccountId(tokens)
  const subscriptionActiveUntil = resolveSubscriptionActiveUntil(tokens)
  const expiresAt = resolveAccessTokenExpiry(accessToken)

  const id = makeCodexAccountId({
    sub: profile.sub,
    chatgptAccountId,
    refreshToken,
    accessToken,
    idToken: tokens?.id_token
  })

  return {
    id,
    enabled: true,
    label: options?.label || profile.email || profile.name || `codex-${id.slice(-6)}`,
    email: profile.email,
    name: profile.name,
    refreshToken,
    accessToken,
    idToken: tokens?.id_token,
    chatgptAccountId,
    subscriptionActiveUntil,
    expiresAt,
    lastRefresh: auth.last_refresh || new Date().toISOString()
  }
}

/** 把 OAuth /token 返回拼成 auth.json payload */
export function buildAuthPayloadFromTokenResponse(response: CodexTokenResponse): CodexAuthPayload {
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    last_refresh: new Date().toISOString(),
    tokens: {
      access_token: response.access_token,
      refresh_token: response.refresh_token,
      id_token: response.id_token,
      account_id: resolveChatGptAccountId({
        access_token: response.access_token,
        id_token: response.id_token
      })
    }
  }
}

export function makeCodexAccountId(input: {
  sub?: string
  chatgptAccountId?: string
  refreshToken?: string
  accessToken?: string
  idToken?: string
}): string {
  if (input.sub && input.chatgptAccountId) return `codex-${input.sub}-${input.chatgptAccountId}`
  if (input.chatgptAccountId) return `codex-acct-${input.chatgptAccountId}`
  if (input.sub) return `codex-sub-${input.sub}`
  const seed = input.refreshToken || input.idToken || input.accessToken || randomUUID()
  return `codex-token-${sha256Short(seed)}`
}

/** 给账户提取面向 UI 的精简信息 */
export function summarizeAccount(account: CodexAccountConfig): CodexAccountInfo {
  return {
    id: account.id,
    email: account.email,
    name: account.name,
    chatgptAccountId: account.chatgptAccountId,
    subscriptionActiveUntil: account.subscriptionActiveUntil,
    expiresAt: account.expiresAt,
    lastRefresh: account.lastRefresh
  }
}

// PKCE helpers
export function createPkceVerifier(): string {
  return randomBytes(48).toString('base64url')
}

export function createPkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/** 解析用户粘贴的 auth.json 文本，可能是单对象、数组或 codexdock 导出包装 */
export function parseCodexAuthInput(text: string): CodexAuthPayload[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }
  return collectAuthPayloads(parsed)
}

function collectAuthPayloads(value: unknown): CodexAuthPayload[] {
  if (!value) return []
  if (Array.isArray(value)) return value.flatMap(collectAuthPayloads)
  if (typeof value !== 'object') return []

  // 标准 auth.json 格式：{ tokens: {...} }
  if (isAuthPayload(value)) return [value as CodexAuthPayload]

  const obj = value as Record<string, unknown>

  // codexdock 导出包装：{ accounts: [...] }
  if (Array.isArray(obj.accounts)) return collectAuthPayloads(obj.accounts)

  // codexdock 单账户节点：{ credentials: {...} }
  const adapted = adaptCodexDockAccount(obj)
  if (adapted) return [adapted]

  return []
}

/** 把 codexdock 导出的 account 节点转换为 CodexAuthPayload */
function adaptCodexDockAccount(node: Record<string, unknown>): CodexAuthPayload | null {
  const creds = node.credentials
  if (!creds || typeof creds !== 'object') return null
  const c = creds as Record<string, unknown>
  const accessToken = typeof c.access_token === 'string' ? c.access_token : undefined
  const refreshToken = typeof c.refresh_token === 'string' ? c.refresh_token : undefined
  const idToken = typeof c.id_token === 'string' ? c.id_token : undefined
  if (!accessToken && !refreshToken) return null
  const accountId = typeof c.chatgpt_account_id === 'string' ? c.chatgpt_account_id : undefined
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    last_refresh: typeof c.last_refresh === 'string' ? c.last_refresh : undefined,
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: idToken,
      account_id: accountId
    }
  }
}

function isAuthPayload(value: unknown): value is CodexAuthPayload {
  if (!value || typeof value !== 'object') return false
  const tokens = (value as CodexAuthPayload).tokens
  if (!tokens || typeof tokens !== 'object') return false
  return Boolean(tokens.refresh_token || tokens.access_token)
}
