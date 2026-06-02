import type { GrokWebAccountConfig } from '../../types'
import { sha256Short } from '../../core/utils'

const GROK_COOKIE_NAMES = new Set([
  'sso',
  'sso-rw',
  'cf_clearance',
  'grok_device_id',
  'x-userid',
  'xai_anon_id'
])

export function normalizeGrokWebImportedAccount(input: unknown): GrokWebAccountConfig | undefined {
  if (!input || typeof input !== 'object') return undefined
  const raw = input as Record<string, any>
  const cookieHeader = normalizeCookieHeader(
    pickString(raw.cookieHeader, raw.cookie_header, raw.cookie, raw.headers?.cookie) ||
      buildCookieHeaderFromCookieArray(raw.cookies) ||
      buildCookieHeaderFromNamedFields(raw)
  )
  if (!cookieHeader) return undefined

  const user = raw.user && typeof raw.user === 'object' ? raw.user : undefined
  const userId = pickString(
    raw.userId,
    raw.user_id,
    raw.xUserId,
    raw.x_user_id,
    user?.userId,
    user?.id,
    getCookieValue(cookieHeader, 'x-userid')
  )
  const email = pickString(raw.email, user?.email)
  const label = pickString(raw.label, raw.name, user?.name, user?.givenName, email, userId)
  const deviceId = pickString(
    raw.grokDeviceId,
    raw.grok_device_id,
    raw.deviceId,
    getCookieValue(cookieHeader, 'grok_device_id')
  )
  const id =
    pickString(raw.id) ||
    (userId
      ? `grokWeb-user-${sha256Short(userId, 12)}`
      : `grokWeb-cookie-${sha256Short(cookieHeader, 12)}`)

  return {
    id,
    label,
    email,
    enabled: raw.enabled !== false,
    cookieHeader,
    userId,
    grokDeviceId: deviceId,
    planType: pickString(raw.planType, raw.plan_type, user?.xSubscriptionType, user?.sessionTierId),
    name: pickString(raw.name, user?.givenName)
  }
}

export function normalizeCookieHeader(value: unknown): string {
  if (typeof value !== 'string') return ''
  const seen = new Set<string>()
  const parts: string[] = []
  for (const rawPart of value.split(';')) {
    const part = rawPart.trim()
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    const cookieValue = part.slice(eq + 1).trim()
    if (!name || !cookieValue) continue
    const lower = name.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    parts.push(`${name}=${cookieValue}`)
  }
  return parts.join('; ')
}

function buildCookieHeaderFromCookieArray(cookies: unknown): string {
  if (!Array.isArray(cookies)) return ''
  const parts: string[] = []
  for (const cookie of cookies) {
    if (!cookie || typeof cookie !== 'object') continue
    const item = cookie as Record<string, unknown>
    const name = pickString(item.name)
    const value = pickString(item.value)
    if (!name || !value) continue
    const domain = pickString(item.domain) || ''
    const lowerDomain = domain.toLowerCase()
    const isGrokCookie = !domain || lowerDomain.includes('grok.com') || lowerDomain.includes('x.ai')
    if (!isGrokCookie && !GROK_COOKIE_NAMES.has(name)) continue
    if (!GROK_COOKIE_NAMES.has(name) && !lowerDomain.includes('grok.com')) continue
    parts.push(`${name}=${value}`)
  }
  return parts.join('; ')
}

function buildCookieHeaderFromNamedFields(raw: Record<string, any>): string {
  const pairs: string[] = []
  for (const name of GROK_COOKIE_NAMES) {
    const camel = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    const snake = name.replace(/-/g, '_')
    const value = pickString(raw[name], raw[camel], raw[snake])
    if (value) pairs.push(`${name}=${value}`)
  }
  return pairs.join('; ')
}

function getCookieValue(cookieHeader: string, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    if (trimmed.slice(0, eq).trim().toLowerCase() === lower) return trimmed.slice(eq + 1).trim()
  }
  return undefined
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return undefined
}
