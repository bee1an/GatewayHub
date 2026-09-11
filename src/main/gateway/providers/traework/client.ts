import type { TraeWorkAccountConfig, TraeWorkProviderSettings } from '../../types'
import { toErrorMessage } from '../../core/utils'
import {
  DEFAULT_TRAEWORK_AUTH_BASE_URL,
  DEFAULT_TRAEWORK_CLIENT_ID,
  DEFAULT_TRAEWORK_CORE_BASE_URL,
  DEFAULT_TRAEWORK_DETAIL_PARAM_PATH,
  TRAEWORK_DETAIL_FUNCTIONS,
  normalizeTraeWorkModel
} from './constants'
import { buildTraeWorkHeaders } from './headers'
import { joinUrl, traeWorkFetch } from './http'

export class TraeWorkAuthError extends Error {
  constructor(
    message: string,
    public readonly status = 0,
    public readonly permanent = false
  ) {
    super(message)
    this.name = 'TraeWorkAuthError'
  }
}

export interface TraeWorkUserInfo {
  email?: string
  userId?: string
  countryCode?: string
  raw?: any
}

export interface TraeWorkTokenSnapshot {
  jwtToken?: string
  refreshToken?: string
  tokenExpiresAt?: number
  refreshExpiresAt?: number
}

export class TraeWorkAuthManager {
  private jwtToken = ''
  private refreshToken = ''
  private tokenExpiresAt = 0
  private refreshExpiresAt = 0
  private refreshInFlight?: Promise<string>
  private onChange?: (snapshot: TraeWorkTokenSnapshot) => Promise<void> | void

  constructor(
    readonly account: TraeWorkAccountConfig,
    private readonly settings: TraeWorkProviderSettings,
    onChange?: (snapshot: TraeWorkTokenSnapshot) => Promise<void> | void
  ) {
    this.onChange = onChange
  }

  initialize(): void {
    this.jwtToken = this.account.jwtToken || ''
    this.refreshToken = this.account.refreshToken || ''
    this.tokenExpiresAt = this.account.tokenExpiresAt || 0
    this.refreshExpiresAt = this.account.refreshExpiresAt || 0
  }

  get authType(): string {
    return this.refreshToken ? 'traework-refresh-token' : 'traework-jwt'
  }

  get expiresAtIso(): string | undefined {
    return this.tokenExpiresAt ? new Date(this.tokenExpiresAt).toISOString() : undefined
  }

  async getJwtToken(): Promise<string> {
    if (this.jwtToken && !this.expiresSoon()) return this.jwtToken
    if (!this.refreshToken) {
      if (this.jwtToken) return this.jwtToken
      throw new TraeWorkAuthError('No TraeWork JWT or refresh token available', 0, true)
    }
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refreshWithTraeWork().finally(() => {
        this.refreshInFlight = undefined
      })
    }
    return this.refreshInFlight
  }

  async getUserInfo(): Promise<TraeWorkUserInfo> {
    const token = await this.getJwtToken()
    const response = await traeWorkFetch(
      joinUrl(authBaseUrl(this.account, this.settings), '/cloudide/api/v3/trae/GetUserInfo'),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Cloud-IDE-JWT ${token}`,
          'x-cloudide-token': token
        },
        body: JSON.stringify({ ReqSource: 'IDE' }),
        signal: AbortSignal.timeout(20_000)
      },
      this.settings
    )
    const payload = await safeJson(response)
    if (!response.ok || isErrorPayload(payload)) {
      const text = stringifyPayload(payload)
      throw new TraeWorkAuthError(
        `TraeWork GetUserInfo failed: HTTP ${response.status} ${text.slice(0, 500)}`,
        response.status,
        response.status === 401 || response.status === 403
      )
    }
    return parseUserInfo(payload)
  }

  /**
   * TraeWork exposes its model catalog through batch_get_detail_param. Chat-capable
   * configs carry usage=chat_completion; entries flagged is_invisible_to_user or
   * config_switch=false are internal/legacy and are filtered out.
   */
  async getModelList(): Promise<string[]> {
    const token = await this.getJwtToken()
    const response = await traeWorkFetch(
      joinUrl(coreBaseUrl(this.account, this.settings), this.modelListPath()),
      {
        method: 'POST',
        headers: {
          ...buildTraeWorkHeaders(token, this.settings, this.account),
          accept: 'application/json'
        },
        body: JSON.stringify({
          functions: TRAEWORK_DETAIL_FUNCTIONS,
          agent_type: 'solo_agent_lite',
          current_config_info: { config_name: '', is_custom_model: false },
          mode_type: 0,
          access_type: 1,
          ab_force_vids: '',
          ab_autotest_advanced_mode: 0,
          show_custom_model: false
        }),
        signal: AbortSignal.timeout(20_000)
      },
      this.settings
    )
    const payload = await safeJson(response)
    if (!response.ok || isErrorPayload(payload)) {
      const text = stringifyPayload(payload)
      throw new TraeWorkAuthError(
        `TraeWork model list failed: HTTP ${response.status} ${text.slice(0, 500)}`,
        response.status,
        response.status === 401 || response.status === 403
      )
    }
    return parseModelListPayload(payload)
  }

  private modelListPath(): string {
    return this.settings.detailParamPath || DEFAULT_TRAEWORK_DETAIL_PARAM_PATH
  }

  private async refreshWithTraeWork(): Promise<string> {
    const url = joinUrl(
      authBaseUrl(this.account, this.settings),
      '/cloudide/api/v3/trae/oauth/ExchangeToken'
    )
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.jwtToken) headers['x-cloudide-token'] = this.jwtToken
    const response = await traeWorkFetch(
      url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ClientID: this.settings.clientId || DEFAULT_TRAEWORK_CLIENT_ID,
          ClientSecret: '-',
          RefreshToken: this.refreshToken,
          UserID: ''
        }),
        signal: AbortSignal.timeout(20_000)
      },
      this.settings
    )
    const payload = await safeJson(response)
    if (!response.ok || isErrorPayload(payload)) {
      const text = stringifyPayload(payload)
      const permanent =
        response.status === 401 || response.status === 403 || /invalid|expired/i.test(text)
      throw new TraeWorkAuthError(
        `TraeWork token refresh failed: HTTP ${response.status} ${text.slice(0, 500)}`,
        response.status,
        permanent
      )
    }
    const snapshot = parseTokenPayload(payload)
    if (!snapshot.jwtToken) {
      throw new TraeWorkAuthError(
        `TraeWork token refresh returned no JWT: ${stringifyPayload(payload).slice(0, 500)}`
      )
    }
    this.jwtToken = snapshot.jwtToken
    if (snapshot.refreshToken) this.refreshToken = snapshot.refreshToken
    if (snapshot.tokenExpiresAt) this.tokenExpiresAt = snapshot.tokenExpiresAt
    if (snapshot.refreshExpiresAt) this.refreshExpiresAt = snapshot.refreshExpiresAt
    await this.onChange?.({
      jwtToken: this.jwtToken,
      refreshToken: this.refreshToken || undefined,
      tokenExpiresAt: this.tokenExpiresAt || undefined,
      refreshExpiresAt: this.refreshExpiresAt || undefined
    })
    return this.jwtToken
  }

  private expiresSoon(): boolean {
    if (!this.tokenExpiresAt) return false
    return Date.now() + 5 * 60_000 > this.tokenExpiresAt
  }
}

function authBaseUrl(account: TraeWorkAccountConfig, settings: TraeWorkProviderSettings): string {
  return account.authBaseUrl || settings.authBaseUrl || DEFAULT_TRAEWORK_AUTH_BASE_URL
}

function coreBaseUrl(account: TraeWorkAccountConfig, settings: TraeWorkProviderSettings): string {
  return account.coreBaseUrl || settings.coreBaseUrl || DEFAULT_TRAEWORK_CORE_BASE_URL
}

function parseTokenPayload(payload: any): TraeWorkTokenSnapshot {
  const result = payload?.Result ?? payload?.result ?? payload?.data ?? payload
  return {
    jwtToken: pickString(
      result?.Token,
      result?.token,
      result?.JwtToken,
      result?.jwtToken,
      result?.accessToken
    ),
    refreshToken: pickString(result?.RefreshToken, result?.refreshToken, result?.refresh_token),
    tokenExpiresAt: normalizeEpoch(
      result?.TokenExpireAt ?? result?.tokenExpireAt ?? result?.TokenExpiresAt ?? result?.expiresAt
    ),
    refreshExpiresAt: normalizeEpoch(
      result?.RefreshExpireAt ?? result?.refreshExpireAt ?? result?.refreshExpiresAt
    )
  }
}

function parseUserInfo(payload: any): TraeWorkUserInfo {
  const result = payload?.Result ?? payload?.result ?? payload?.data ?? payload
  return {
    email: normalizeEmail(
      result?.Email || result?.email || result?.NonPlainTextEmail || result?.nonPlainTextEmail
    ),
    userId: pickString(result?.UserID, result?.UserId, result?.userId, result?.id),
    countryCode: pickString(
      result?.StoreCountryCode,
      result?.storeCountryCode,
      result?.CountryCode,
      result?.countryCode,
      result?.AIRegion,
      result?.aiRegion
    )?.toUpperCase(),
    raw: result
  }
}

export function parseModelListPayload(payload: any): string[] {
  const root = payload?.Result ?? payload?.result ?? payload?.data ?? payload
  const functionConfigs = root?.function_configs ?? root?.functionConfigs
  const models = new Set<string>()
  if (Array.isArray(functionConfigs)) {
    for (const fn of functionConfigs) {
      collectDetailParamModels(fn?.config_info_list ?? fn?.configInfoList, models)
    }
  }
  collectDetailParamModels(root?.config_info_list ?? root?.configInfoList, models)
  return [...models].sort()
}

function collectDetailParamModels(list: any, models: Set<string>): void {
  if (!Array.isArray(list)) return
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const usage = pickString(item.usage, item.Usage)
    if (usage && usage !== 'chat_completion') continue
    if (item.config_switch === false || item.configSwitch === false) continue
    if (item.is_invisible_to_user === true || item.isInvisibleToUser === true) continue
    const id = pickString(item.config_name, item.configName, item.model_name, item.modelName)
    if (!id || !/[a-z]/i.test(id)) continue
    models.add(normalizeTraeWorkModel(id))
  }
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

function isErrorPayload(payload: any): boolean {
  const code = payload?.code ?? payload?.Code ?? payload?.error?.code
  if (code === undefined || code === null) return false
  return !(code === 0 || code === '0' || code === 'OK' || code === 'ok')
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
  if (typeof value === 'number' && Number.isFinite(value) && value > 0)
    return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : undefined
}
