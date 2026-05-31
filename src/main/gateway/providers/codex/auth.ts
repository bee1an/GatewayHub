import type { CodexAccountConfig, CodexProviderSettings } from '../../types'
import { toErrorMessage } from '../../core/utils'
import {
  CODEX_ORIGINATOR,
  CODEX_USER_AGENT,
  OPENAI_OAUTH_CLIENT_ID,
  OPENAI_TOKEN_URL
} from './constants'
import {
  buildAuthPayloadFromTokenResponse,
  decodeJwtPayload,
  resolveAccessTokenExpiry,
  resolveGptWebAccountId,
  resolveProfileFromTokens,
  resolveSubscriptionActiveUntil
} from './normalize'
import type { CodexTokenResponse } from './types'

export class CodexAuthRefreshError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly permanent: boolean
  ) {
    super(message)
  }
}

/** 带可选代理的 fetch（与 kiroFetch 同款实现） */
export async function codexFetch(
  url: string,
  init: RequestInit,
  proxyUrl?: string
): Promise<Response> {
  if (!proxyUrl) return fetch(url, init)
  try {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string
    ) => Promise<any>
    const undici = await dynamicImport('undici')
    const proxy = proxyUrl.includes('://') ? proxyUrl : `http://${proxyUrl}`
    const dispatcher = new undici.ProxyAgent(proxy)
    return undici.fetch(url, { ...init, dispatcher }) as Promise<Response>
  } catch (error) {
    throw new Error(`Codex proxy setup failed for ${proxyUrl}: ${toErrorMessage(error)}`)
  }
}

/** 用 refresh_token 换新 access_token；失败抛 CodexAuthRefreshError */
export async function refreshCodexTokens(
  refreshToken: string,
  proxyUrl?: string
): Promise<CodexTokenResponse> {
  const response = await codexFetch(
    OPENAI_TOKEN_URL,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: OPENAI_OAUTH_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      })
    },
    proxyUrl
  )
  if (!response.ok) {
    const text = await safeText(response)
    const permanent = response.status === 401 || response.status === 403
    throw new CodexAuthRefreshError(
      `Codex token refresh failed: HTTP ${response.status} ${text.slice(0, 500)}`,
      response.status,
      permanent
    )
  }
  return (await response.json()) as CodexTokenResponse
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 1000)
  } catch {
    return ''
  }
}

/**
 * 管理一个 Codex 账户的 token 状态。
 *
 * 与 KiroAuthManager 类似，但语义针对 GptWeb OAuth：
 * - access_token 是短期 JWT，exp 来自 JWT 自身
 * - refresh_token 长期有效；如果上游返回 401 视为永久失效，不再重试
 * - gptWeb-account-id / originator 是请求 GptWeb 后端的强制头部
 */
export class CodexAuthManager {
  readonly account: CodexAccountConfig
  readonly settings: CodexProviderSettings

  private accessToken = ''
  private refreshToken = ''
  private idToken = ''
  private gptWebAccountId = ''
  private expiresAtMs = 0
  private lastRefreshIso = ''
  private subscriptionActiveUntil = ''
  private email = ''
  private name = ''
  private refreshInFlight?: Promise<string>
  /** refresh 失败后缓存的错误，避免短时间内重复打 401 */
  private permanentFailure?: { error: CodexAuthRefreshError; refreshToken: string }
  private onChange?: (snapshot: CodexAccountSnapshot) => Promise<void> | void

  constructor(
    account: CodexAccountConfig,
    settings: CodexProviderSettings,
    onChange?: (snapshot: CodexAccountSnapshot) => Promise<void> | void
  ) {
    this.account = account
    this.settings = settings
    this.onChange = onChange
  }

  initialize(): void {
    this.accessToken = this.account.accessToken || ''
    this.refreshToken = this.account.refreshToken || ''
    this.idToken = this.account.idToken || ''
    this.gptWebAccountId =
      this.account.gptWebAccountId ||
      resolveGptWebAccountId({
        access_token: this.accessToken,
        id_token: this.idToken
      }) ||
      ''
    this.expiresAtMs = this.account.expiresAt || resolveAccessTokenExpiry(this.accessToken) || 0
    this.lastRefreshIso = this.account.lastRefresh || ''
    this.subscriptionActiveUntil = this.account.subscriptionActiveUntil || ''
    this.email = this.account.email || ''
    this.name = this.account.name || ''
  }

  get expiresAtIso(): string | undefined {
    return this.expiresAtMs ? new Date(this.expiresAtMs).toISOString() : undefined
  }

  get authType(): string {
    return 'gptWeb-oauth'
  }

  get authenticatedAccountId(): string {
    return this.gptWebAccountId
  }

  /** 获取一个有效 access_token，必要时刷新 */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && !this.expiresSoon()) return this.accessToken
    if (!this.refreshToken) {
      // 无 refresh_token，只能用现有 access_token
      if (this.accessToken) return this.accessToken
      throw new CodexAuthRefreshError('No access or refresh token available', 0, true)
    }
    if (this.refreshInFlight) return this.refreshInFlight
    this.refreshInFlight = this.doRefresh().finally(() => {
      this.refreshInFlight = undefined
    })
    return this.refreshInFlight
  }

  async forceRefresh(): Promise<string> {
    if (!this.refreshToken) {
      throw new CodexAuthRefreshError('No refresh token available', 0, true)
    }
    if (this.refreshInFlight) return this.refreshInFlight
    this.refreshInFlight = this.doRefresh().finally(() => {
      this.refreshInFlight = undefined
    })
    return this.refreshInFlight
  }

  /** 构造 GptWeb 后端必带头部 */
  buildHeaders(token: string): Record<string, string> {
    if (!this.gptWebAccountId) {
      throw new Error(
        `Codex account ${this.account.id} is missing gptWeb-account-id; please re-login`
      )
    }
    return {
      authorization: `Bearer ${token}`,
      'gptWeb-account-id': this.gptWebAccountId,
      originator: CODEX_ORIGINATOR,
      'user-agent': CODEX_USER_AGENT,
      'content-type': 'application/json'
    }
  }

  private expiresSoon(): boolean {
    if (!this.expiresAtMs) return true
    return this.expiresAtMs - Date.now() <= this.settings.refreshSkewSeconds * 1000
  }

  private async doRefresh(): Promise<string> {
    if (this.permanentFailure?.refreshToken === this.refreshToken) {
      throw this.permanentFailure.error
    }
    try {
      const response = await refreshCodexTokens(this.refreshToken, this.settings.vpnProxyUrl)
      this.applyTokenResponse(response)
      this.permanentFailure = undefined
      await this.onChange?.(this.snapshot())
      return this.accessToken
    } catch (error) {
      if (error instanceof CodexAuthRefreshError && error.permanent) {
        this.permanentFailure = { error, refreshToken: this.refreshToken }
      }
      throw error
    }
  }

  private applyTokenResponse(response: CodexTokenResponse): void {
    this.accessToken = response.access_token
    if (response.refresh_token) this.refreshToken = response.refresh_token
    if (response.id_token) this.idToken = response.id_token
    const auth = buildAuthPayloadFromTokenResponse({
      access_token: this.accessToken,
      refresh_token: this.refreshToken,
      id_token: this.idToken
    })
    this.lastRefreshIso = auth.last_refresh || new Date().toISOString()
    this.expiresAtMs = resolveAccessTokenExpiry(this.accessToken) || 0
    const accountId = resolveGptWebAccountId(auth.tokens)
    if (accountId) this.gptWebAccountId = accountId
    const profile = resolveProfileFromTokens(auth.tokens)
    if (profile.email) this.email = profile.email
    if (profile.name) this.name = profile.name
    const sub = resolveSubscriptionActiveUntil(auth.tokens)
    if (sub) this.subscriptionActiveUntil = sub
  }

  snapshot(): CodexAccountSnapshot {
    return {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      idToken: this.idToken,
      gptWebAccountId: this.gptWebAccountId,
      expiresAt: this.expiresAtMs || undefined,
      lastRefresh: this.lastRefreshIso || undefined,
      subscriptionActiveUntil: this.subscriptionActiveUntil || undefined,
      email: this.email || undefined,
      name: this.name || undefined
    }
  }
}

export interface CodexAccountSnapshot {
  accessToken: string
  refreshToken: string
  idToken: string
  gptWebAccountId: string
  expiresAt?: number
  lastRefresh?: string
  subscriptionActiveUntil?: string
  email?: string
  name?: string
}

/** 解析 access_token 是否已过期（不带任何 skew） */
export function isAccessTokenExpired(token: string | undefined): boolean {
  if (!token) return true
  const claims = decodeJwtPayload(token)
  const exp = claims?.exp
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return true
  return exp * 1000 <= Date.now()
}
