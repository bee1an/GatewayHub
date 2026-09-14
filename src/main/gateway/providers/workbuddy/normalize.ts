import type { WorkBuddyAccountConfig } from '../../types'
import { sha256Short } from '../../core/utils'
import { DEFAULT_WORKBUDDY_DOMAIN } from './constants'

export function parseWorkBuddyAuthInput(text: string): WorkBuddyAccountConfig[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  let parsed: any
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    const account = buildWorkBuddyAccountFromInput({ accessToken: trimmed })
    return account ? [account] : []
  }
  const items = extractCandidateObjects(parsed)
  const accounts: WorkBuddyAccountConfig[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const account = buildWorkBuddyAccountFromInput(item)
    if (!account || seen.has(account.id)) continue
    seen.add(account.id)
    accounts.push(account)
  }
  return accounts
}

/**
 * Accepts a raw access token, a pasted workbuddy-desktop.info document
 * ({session:{auth,account}} or top-level auth/account), or a flat credentials
 * object ({accessToken, refreshToken, uid, ...}).
 */
export function buildWorkBuddyAccountFromInput(input: any): WorkBuddyAccountConfig | null {
  if (!input || typeof input !== 'object') return null
  const session = input.session && typeof input.session === 'object' ? input.session : input
  const auth = session.auth && typeof session.auth === 'object' ? session.auth : session
  const account = session.account && typeof session.account === 'object' ? session.account : {}

  const accessToken = stripBearerPrefix(
    pickString(
      auth.accessToken,
      auth.access_token,
      auth.token,
      input.accessToken,
      input.access_token,
      input.token
    )
  )
  const refreshToken = pickString(
    auth.refreshToken,
    auth.refresh_token,
    input.refreshToken,
    input.refresh_token
  )
  if (!accessToken && !refreshToken) return null

  const uid = pickString(
    account.uid,
    account.userId,
    account.user_id,
    input.uid,
    input.userId,
    input.user_id
  )
  const nickname = pickString(
    account.nickname,
    account.username,
    account.name,
    input.nickname,
    input.label,
    input.name
  )
  const email = normalizeEmail(account.email || account.mail || input.email || input.mail)
  const id = uid
    ? `workbuddy-user-${sha256Short(uid, 12)}`
    : refreshToken
      ? `workbuddy-refresh-${sha256Short(refreshToken, 12)}`
      : `workbuddy-token-${sha256Short(accessToken || Math.random().toString(), 12)}`

  return {
    id: pickString(input.id) || id,
    label: pickString(input.label, input.name) || nickname || email || `WorkBuddy ${id.slice(-6)}`,
    email,
    enabled: input.enabled !== false,
    accessToken: accessToken || undefined,
    refreshToken: refreshToken || undefined,
    tokenExpiresAt: normalizeEpoch(
      auth.expiresAt ?? auth.expires_at ?? input.tokenExpiresAt ?? input.expiresAt
    ),
    refreshExpiresAt: normalizeEpoch(
      auth.refreshExpiresAt ?? auth.refresh_expires_at ?? input.refreshExpiresAt
    ),
    uid: uid || undefined,
    enterpriseId:
      pickString(account.enterpriseId, account.enterprise_id, input.enterpriseId) || undefined,
    nickname: nickname || undefined,
    domain: pickString(auth.domain, input.domain) || DEFAULT_WORKBUDDY_DOMAIN,
    authType:
      pickString(input.authType, input.auth_type) ||
      (refreshToken ? 'workbuddy-refresh-token' : 'workbuddy-token')
  }
}

function extractCandidateObjects(parsed: any): any[] {
  if (Array.isArray(parsed)) return parsed
  if (Array.isArray(parsed?.accounts)) return parsed.accounts
  if (Array.isArray(parsed?.items)) return parsed.items
  if (Array.isArray(parsed?.credentials)) return parsed.credentials
  return [parsed]
}

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return ''
}

function stripBearerPrefix(value: string): string {
  return value.replace(/^Bearer\s+/i, '').trim()
}

function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : undefined
}

function normalizeEpoch(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}
