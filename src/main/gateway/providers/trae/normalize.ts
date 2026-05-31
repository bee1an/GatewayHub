import type { TraeAccountConfig } from '../../types'
import { sha256Short } from '../../core/utils'

export function parseTraeAuthInput(text: string): TraeAccountConfig[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  let parsed: any
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    const account = buildTraeAccountFromInput({ jwtToken: trimmed })
    return account ? [account] : []
  }
  const items = extractCandidateObjects(parsed)
  const accounts: TraeAccountConfig[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const account = buildTraeAccountFromInput(item)
    if (!account || seen.has(account.id)) continue
    seen.add(account.id)
    accounts.push(account)
  }
  return accounts
}

export function buildTraeAccountFromInput(input: any): TraeAccountConfig | null {
  if (!input || typeof input !== 'object') return null
  const tokens = input.tokens && typeof input.tokens === 'object' ? input.tokens : undefined
  const jwtToken = stripCloudIdeJwtPrefix(
    pickString(
      input.jwtToken,
      input.cloudIdeJwt,
      input.cloud_ide_jwt,
      input.CloudIDEJWT,
      input.CloudIdeJwt,
      input.accessToken,
      input.access_token,
      input.token,
      input.Token,
      tokens?.jwtToken,
      tokens?.accessToken,
      tokens?.access_token
    )
  )
  const refreshToken = pickString(
    input.refreshToken,
    input.refresh_token,
    input.RefreshToken,
    tokens?.refreshToken,
    tokens?.refresh_token
  )
  if (!jwtToken && !refreshToken) return null
  const email = normalizeEmail(
    input.email ||
      input.mail ||
      input.user?.email ||
      input.userInfo?.email ||
      input.profile?.email ||
      input.account?.email
  )
  const userId = pickString(
    input.userId,
    input.user_id,
    input.UserID,
    input.user?.id,
    input.userInfo?.id,
    input.account?.id,
    input.account?.userId
  )
  const countryCode = pickString(
    input.countryCode,
    input.country_code,
    input.aiRegion,
    input.AIRegion,
    input.storeCountryCode,
    input.StoreCountryCode,
    input.region,
    input.userRegion?._aiRegion,
    input.account?.storeRegion,
    input.account?.storeCountryCode
  )?.toUpperCase()
  const seed = userId || email || refreshToken || jwtToken || Math.random().toString()
  const id = userId
    ? `trae-user-${sha256Short(userId, 12)}`
    : refreshToken
      ? `trae-refresh-${sha256Short(refreshToken, 12)}`
      : `trae-jwt-${sha256Short(jwtToken || seed, 12)}`
  return {
    id: pickString(input.id) || id,
    label:
      pickString(input.label, input.name, input.account?.username) ||
      email ||
      `Trae ${id.slice(-6)}`,
    email,
    enabled: input.enabled !== false,
    jwtToken: jwtToken || undefined,
    refreshToken: refreshToken || undefined,
    tokenExpiresAt: normalizeEpoch(
      input.tokenExpiresAt ?? input.token_expires_at ?? input.expiredAt ?? input.expiresAt
    ),
    refreshExpiresAt: normalizeEpoch(
      input.refreshExpiresAt ?? input.refresh_expires_at ?? input.refreshExpiredAt
    ),
    userId: userId || undefined,
    countryCode: countryCode || undefined,
    authType:
      pickString(input.authType, input.auth_type) ||
      (refreshToken ? 'trae-refresh-token' : 'trae-jwt'),
    authBaseUrl: pickString(input.authBaseUrl, input.auth_base_url) || undefined,
    coreBaseUrl: pickString(input.coreBaseUrl, input.core_base_url) || undefined
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

function stripCloudIdeJwtPrefix(value: string): string {
  return value.replace(/^Cloud-IDE-JWT\s+/i, '').trim()
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
