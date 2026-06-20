import type { GeminiWebAccountConfig } from '../../types'
import { sha256Short } from '../../core/utils'

// Gemini web auth relies on Google sign-in cookies. __Secure-1PSID is the
// load-bearing session cookie; the others improve resilience (SIDTS rotation,
// NID, etc.). We accept the whole cookie header since a full export is most
// reliable, but also accept a single __Secure-1PSID value.
const GEMINI_COOKIE_NAMES = new Set([
  '__secure-1psid',
  '__secure-3psid',
  '__secure-1psidts',
  '__secure-3psidts',
  'sid',
  'hsid',
  'ssid',
  'apisid',
  'sapisid',
  '__secure-1papisid',
  '__secure-3papisid',
  'nid'
])

export function normalizeGeminiWebImportedAccount(
  input: unknown
): GeminiWebAccountConfig | undefined {
  if (!input || typeof input !== 'object') return undefined
  const raw = input as Record<string, any>

  const cookieHeader = normalizeCookieHeader(
    pickString(raw.cookieHeader, raw.cookie_header, raw.cookie, raw.headers?.cookie) ||
      buildCookieHeaderFromCookieArray(raw.cookies) ||
      buildCookieHeaderFromNamedFields(raw) ||
      pickString(raw.__Secure_1PSID, raw.secure1psid, raw.psId, raw.psid)
  )
  if (!cookieHeader || !getCookieValue(cookieHeader, '__Secure-1PSID')) {
    // Gemini web auth is not usable without the primary session cookie.
    return undefined
  }

  const user = raw.user && typeof raw.user === 'object' ? raw.user : undefined
  const email = pickString(raw.email, user?.email)
  const label = pickString(raw.label, raw.name, user?.name, user?.givenName, email)
  const id = pickString(raw.id) || `geminiWeb-cookie-${sha256Short(cookieHeader.slice(0, 64), 12)}`

  return {
    id,
    label,
    email,
    enabled: raw.enabled !== false,
    cookieHeader,
    planType: pickString(raw.planType, raw.plan_type, user?.accountTier)
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
  // A full browser cookie export contains more than just the bare-minimum
  // session cookies (SIDCC, *PSIDCC, COMPASS, NID all improve resilience).
  // Keep them all rather than filtering to a subset — Gemini validates the
  // whole cookie jar, so dropping cookies risks auth failures.
  const parts: string[] = []
  for (const cookie of cookies) {
    if (!cookie || typeof cookie !== 'object') continue
    const item = cookie as Record<string, unknown>
    const name = pickString(item.name)
    const value = item.value === null || item.value === undefined ? '' : String(item.value)
    if (!name || !value) continue
    parts.push(`${name}=${value}`)
  }
  return parts.join('; ')
}

function buildCookieHeaderFromNamedFields(raw: Record<string, any>): string {
  const pairs: string[] = []
  // Index the input keys case- and separator-insensitively so callers can pass
  // "__Secure-1PSID", "__Secure_1PSID", "secure1psid", etc.
  const index = new Map<string, string>()
  for (const [key, value] of Object.entries(raw)) {
    const normalized = key.toLowerCase().replace(/[-_]/g, '')
    if (typeof value === 'string' && value.trim() && !index.has(normalized)) {
      index.set(normalized, value.trim())
    }
  }
  for (const name of GEMINI_COOKIE_NAMES) {
    const lookup = name.toLowerCase().replace(/[-_]/g, '')
    const value = index.get(lookup)
    if (value) pairs.push(`${name}=${value}`)
  }
  return pairs.join('; ')
}

export function getCookieValue(cookieHeader: string, name: string): string | undefined {
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
