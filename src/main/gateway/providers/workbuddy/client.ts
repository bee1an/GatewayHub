import type { WorkBuddyAccountConfig, WorkBuddyProviderSettings } from '../../types'
import { toErrorMessage } from '../../core/utils'
import {
  DEFAULT_WORKBUDDY_BACKEND,
  DEFAULT_WORKBUDDY_DOMAIN,
  WORKBUDDY_TOKEN_REFRESH_PATH
} from './constants'
import { joinUrl, workBuddyFetch } from './http'

export class WorkBuddyAuthError extends Error {
  constructor(
    message: string,
    public readonly status = 0,
    public readonly permanent = false
  ) {
    super(message)
    this.name = 'WorkBuddyAuthError'
  }
}

export interface WorkBuddyTokenSnapshot {
  accessToken?: string
  refreshToken?: string
  tokenExpiresAt?: number
  refreshExpiresAt?: number
  domain?: string
}

export const WORKBUDDY_USER_AGENT = 'WorkBuddy/GatewayHub'

/**
 * Copilot request headers observed in WorkBuddy desktop + plugin traffic:
 * Bearer token + X-User-Id/X-Enterprise-Id/X-Tenant-Id + X-Domain.
 */
export function buildWorkBuddyHeaders(
  account: WorkBuddyAccountConfig,
  token: string
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'x-user-id': account.uid || '',
    'x-domain': account.domain || DEFAULT_WORKBUDDY_DOMAIN,
    'user-agent': WORKBUDDY_USER_AGENT
  }
  if (account.enterpriseId) {
    headers['x-enterprise-id'] = account.enterpriseId
    headers['x-tenant-id'] = account.enterpriseId
  }
  return headers
}

export class WorkBuddyAuthManager {
  private accessToken = ''
  private refreshToken = ''
  private tokenExpiresAt = 0
  private refreshExpiresAt = 0
  private domain = ''
  private refreshInFlight?: Promise<string>
  private onChange?: (snapshot: WorkBuddyTokenSnapshot) => Promise<void> | void

  constructor(
    readonly account: WorkBuddyAccountConfig,
    private readonly settings: WorkBuddyProviderSettings,
    onChange?: (snapshot: WorkBuddyTokenSnapshot) => Promise<void> | void
  ) {
    this.onChange = onChange
  }

  initialize(): void {
    this.accessToken = this.account.accessToken || ''
    this.refreshToken = this.account.refreshToken || ''
    this.tokenExpiresAt = this.account.tokenExpiresAt || 0
    this.refreshExpiresAt = this.account.refreshExpiresAt || 0
    this.domain = this.account.domain || ''
  }

  get authType(): string {
    return this.refreshToken ? 'workbuddy-refresh-token' : 'workbuddy-token'
  }

  get expiresAtIso(): string | undefined {
    return this.tokenExpiresAt ? new Date(this.tokenExpiresAt).toISOString() : undefined
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && !this.expiresSoon()) return this.accessToken
    if (!this.refreshToken) {
      if (this.accessToken) return this.accessToken
      throw new WorkBuddyAuthError('No WorkBuddy access or refresh token available', 0, true)
    }
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refreshWithWorkBuddy().finally(() => {
        this.refreshInFlight = undefined
      })
    }
    return this.refreshInFlight
  }

  /**
   * POST {backend}/v2/plugin/auth/token/refresh with X-Refresh-Token.
   * Response: { code: 0, data: { accessToken, refreshToken, expiresAt,
   * refreshExpiresAt, expiresIn, refreshExpiresIn, domain? } }.
   */
  private async refreshWithWorkBuddy(): Promise<string> {
    const url = joinUrl(
      this.settings.backend || DEFAULT_WORKBUDDY_BACKEND,
      WORKBUDDY_TOKEN_REFRESH_PATH
    )
    const response = await workBuddyFetch(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-refresh-token': this.refreshToken,
          'x-auth-refresh-source': 'plugin',
          'x-user-id': this.account.uid || '',
          'x-domain': this.domain || this.account.domain || DEFAULT_WORKBUDDY_DOMAIN,
          'user-agent': WORKBUDDY_USER_AGENT
        },
        body: '{}',
        signal: AbortSignal.timeout(20_000)
      },
      this.settings
    )
    const payload = await safeJson(response)
    const code = payload?.code ?? payload?.Code
    const failed =
      !response.ok || (code !== undefined && code !== null && code !== 0 && code !== '0')
    if (failed) {
      const text = stringifyPayload(payload)
      const permanent =
        response.status === 401 || response.status === 403 || /invalid|expired/i.test(text)
      throw new WorkBuddyAuthError(
        `WorkBuddy token refresh failed: HTTP ${response.status} ${text.slice(0, 500)}`,
        response.status,
        permanent
      )
    }
    const data = payload?.data ?? payload?.Data ?? payload
    const snapshot = parseTokenPayload(data)
    if (!snapshot.accessToken) {
      throw new WorkBuddyAuthError(
        `WorkBuddy token refresh returned no token: ${stringifyPayload(payload).slice(0, 500)}`
      )
    }
    this.accessToken = snapshot.accessToken
    if (snapshot.refreshToken) this.refreshToken = snapshot.refreshToken
    if (snapshot.tokenExpiresAt) this.tokenExpiresAt = snapshot.tokenExpiresAt
    if (snapshot.refreshExpiresAt) this.refreshExpiresAt = snapshot.refreshExpiresAt
    if (snapshot.domain) this.domain = snapshot.domain
    await this.onChange?.({
      accessToken: this.accessToken,
      refreshToken: this.refreshToken || undefined,
      tokenExpiresAt: this.tokenExpiresAt || undefined,
      refreshExpiresAt: this.refreshExpiresAt || undefined,
      domain: this.domain || undefined
    })
    return this.accessToken
  }

  private expiresSoon(): boolean {
    if (!this.tokenExpiresAt) return false
    return Date.now() + 5 * 60_000 > this.tokenExpiresAt
  }
}

function parseTokenPayload(data: any): WorkBuddyTokenSnapshot {
  return {
    accessToken: pickString(data?.accessToken, data?.access_token, data?.token),
    refreshToken: pickString(data?.refreshToken, data?.refresh_token),
    tokenExpiresAt: normalizeExpiry(data?.expiresAt ?? data?.expires_at, data?.expiresIn),
    refreshExpiresAt: normalizeExpiry(
      data?.refreshExpiresAt ?? data?.refresh_expires_at,
      data?.refreshExpiresIn
    ),
    domain: pickString(data?.domain)
  }
}

/** expiresAt may be epoch ms; expiresIn is seconds-from-now. */
function normalizeExpiry(epochValue: unknown, secondsValue: unknown): number | undefined {
  const epoch = normalizeEpoch(epochValue)
  if (epoch) return epoch
  const seconds = Number(secondsValue)
  if (Number.isFinite(seconds) && seconds > 0) return Date.now() + seconds * 1000
  return undefined
}

async function safeJson(response: Response): Promise<any> {
  const text = await response.text().catch((error) => toErrorMessage(error))
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { rawText: text }
  }
}

function stringifyPayload(payload: any): string {
  try {
    if (typeof payload?.rawText === 'string') return payload.rawText
    return JSON.stringify(payload)
  } catch {
    return String(payload)
  }
}

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return ''
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
