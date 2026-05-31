import type { TraeAccountConfig, TraeProviderSettings } from '../../types'
import { toErrorMessage } from '../../core/utils'
import {
  DEFAULT_TRAE_AUTH_BASE_URL,
  DEFAULT_TRAE_CLIENT_ID,
  DEFAULT_TRAE_CORE_BASE_URL,
  DEFAULT_TRAE_MODEL_LIST_PATH,
  normalizeTraeModel
} from './constants'
import { buildTraeIdeHeaders } from './headers'
import { joinUrl, traeFetch } from './http'

export class TraeAuthError extends Error {
  constructor(
    message: string,
    public readonly status = 0,
    public readonly permanent = false
  ) {
    super(message)
    this.name = 'TraeAuthError'
  }
}

export interface TraeUserInfo {
  email?: string
  userId?: string
  countryCode?: string
  raw?: any
}

export interface TraeTokenSnapshot {
  jwtToken?: string
  refreshToken?: string
  tokenExpiresAt?: number
  refreshExpiresAt?: number
}

export class TraeAuthManager {
  private jwtToken = ''
  private refreshToken = ''
  private tokenExpiresAt = 0
  private refreshExpiresAt = 0
  private refreshInFlight?: Promise<string>
  private onChange?: (snapshot: TraeTokenSnapshot) => Promise<void> | void

  constructor(
    readonly account: TraeAccountConfig,
    private readonly settings: TraeProviderSettings,
    onChange?: (snapshot: TraeTokenSnapshot) => Promise<void> | void
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
    return this.refreshToken ? 'trae-refresh-token' : 'trae-jwt'
  }

  get expiresAtIso(): string | undefined {
    return this.tokenExpiresAt ? new Date(this.tokenExpiresAt).toISOString() : undefined
  }

  async getJwtToken(): Promise<string> {
    if (this.jwtToken && !this.expiresSoon()) return this.jwtToken
    if (!this.refreshToken) {
      if (this.jwtToken) return this.jwtToken
      throw new TraeAuthError('No Trae JWT or refresh token available', 0, true)
    }
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refreshWithTrae().finally(() => {
        this.refreshInFlight = undefined
      })
    }
    return this.refreshInFlight
  }

  buildAuthorizationHeaders(token: string): Record<string, string> {
    return {
      authorization: `Cloud-IDE-JWT ${token}`,
      'x-cloudide-token': token
    }
  }

  async getUserInfo(): Promise<TraeUserInfo> {
    const token = await this.getJwtToken()
    const response = await traeFetch(
      joinUrl(authBaseUrl(this.account, this.settings), '/cloudide/api/v3/trae/GetUserInfo'),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.buildAuthorizationHeaders(token)
        },
        body: JSON.stringify({ ReqSource: 'IDE' }),
        signal: AbortSignal.timeout(20_000)
      },
      this.settings
    )
    const payload = await safeJson(response)
    if (!response.ok || isErrorPayload(payload)) {
      const text = stringifyPayload(payload)
      throw new TraeAuthError(
        `Trae GetUserInfo failed: HTTP ${response.status} ${text.slice(0, 500)}`,
        response.status,
        response.status === 401 || response.status === 403
      )
    }
    return parseUserInfo(payload)
  }

  async getModelList(): Promise<string[]> {
    const token = await this.getJwtToken()
    const path = this.settings.modelListPath || DEFAULT_TRAE_MODEL_LIST_PATH
    const isDetailParam = /\/get_detail_param(?:$|\?)/.test(path)
    const response = await traeFetch(
      joinUrl(coreBaseUrl(this.account, this.settings), path),
      {
        method: isDetailParam ? 'POST' : 'GET',
        headers: {
          accept: 'application/json',
          ...(isDetailParam ? { 'content-type': 'application/json' } : {}),
          ...buildTraeIdeHeaders(token, this.settings),
          'x-app-function': 'chat',
          'x-ide-function': 'chat'
        },
        body: isDetailParam
          ? JSON.stringify({
              function: 'chat',
              need_prompt: true,
              poly_prompt: true,
              omit_encrypted_model_param: false
            })
          : undefined,
        signal: AbortSignal.timeout(20_000)
      },
      this.settings
    )
    const payload = await safeJson(response)
    if (!response.ok || isErrorPayload(payload)) {
      const text = stringifyPayload(payload)
      throw new TraeAuthError(
        `Trae model list failed: HTTP ${response.status} ${text.slice(0, 500)}`,
        response.status,
        response.status === 401 || response.status === 403
      )
    }
    return parseModelListPayload(payload)
  }

  private async refreshWithTrae(): Promise<string> {
    const url = joinUrl(
      authBaseUrl(this.account, this.settings),
      '/cloudide/api/v3/trae/oauth/ExchangeToken'
    )
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.jwtToken) headers['x-cloudide-token'] = this.jwtToken
    const response = await traeFetch(
      url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ClientID: this.settings.clientId || DEFAULT_TRAE_CLIENT_ID,
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
      throw new TraeAuthError(
        `Trae token refresh failed: HTTP ${response.status} ${text.slice(0, 500)}`,
        response.status,
        permanent
      )
    }
    const snapshot = parseTokenPayload(payload)
    if (!snapshot.jwtToken) {
      throw new TraeAuthError(
        `Trae token refresh returned no JWT: ${stringifyPayload(payload).slice(0, 500)}`
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

function authBaseUrl(account: TraeAccountConfig, settings: TraeProviderSettings): string {
  return account.authBaseUrl || settings.authBaseUrl || DEFAULT_TRAE_AUTH_BASE_URL
}

function coreBaseUrl(account: TraeAccountConfig, settings: TraeProviderSettings): string {
  return account.coreBaseUrl || settings.coreBaseUrl || DEFAULT_TRAE_CORE_BASE_URL
}

function parseTokenPayload(payload: any): TraeTokenSnapshot {
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

function parseUserInfo(payload: any): TraeUserInfo {
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
  const detailParamModels = parseDetailParamModels(root)
  if (detailParamModels.length) return detailParamModels
  const candidates = [
    root?.model_configs,
    root?.modelConfigs,
    root?.models,
    root?.items,
    root?.list,
    root?.function_model_list,
    root?.functionModelList,
    root
  ]
  const models = new Set<string>()
  const seen = new Set<any>()
  for (let i = 0; i < candidates.length; i++) {
    collectModelIds(candidateAt(candidates, i), models, seen, 0, i < candidates.length - 1)
  }
  return [...models].sort()
}

function parseDetailParamModels(root: any): string[] {
  const list = root?.config_info_list ?? root?.configInfoList
  if (!Array.isArray(list)) return []
  const models = new Set<string>()
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    if (isDisabledModelEntry(item)) continue
    const usage = pickString(item.usage, item.Usage)
    if (usage && usage !== 'chat_completion') continue
    const id = pickString(item.config_name, item.configName, item.model_name, item.modelName)
    const normalized = normalizeMaybeModel(id)
    if (normalized) models.add(normalized)
  }
  return [...models].sort()
}

function candidateAt(candidates: any[], index: number): any {
  return candidates[index]
}

function collectModelIds(
  value: any,
  models: Set<string>,
  seen: Set<any>,
  depth: number,
  inModelContainer: boolean
): void {
  if (!value || depth > 6) return
  if (typeof value === 'string') {
    const normalized = inModelContainer ? normalizeMaybeModel(value) : ''
    if (normalized) models.add(normalized)
    return
  }
  if (typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) collectModelIds(item, models, seen, depth + 1, inModelContainer)
    return
  }
  if (isDisabledModelEntry(value)) return
  if (inModelContainer) {
    for (const [key, child] of Object.entries(value)) {
      if (isSchemaKey(key)) continue
      if (child && typeof child === 'object' && isDisabledModelEntry(child)) continue
      const normalizedKey = normalizeMaybeModel(key)
      if (normalizedKey) models.add(normalizedKey)
    }
  }
  const id = pickString(
    value.model_name,
    value.modelName,
    value.model_id,
    value.modelId,
    value.name,
    value.id,
    value.key
  )
  const normalized = normalizeMaybeModel(id)
  if (normalized) models.add(normalized)
  for (const key of [
    'models',
    'model_configs',
    'modelConfigs',
    'children',
    'selectables',
    'function_model_list',
    'functionModelList',
    'items',
    'list'
  ]) {
    collectModelIds(value[key], models, seen, depth + 1, true)
  }
  if (inModelContainer) {
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') collectModelIds(child, models, seen, depth + 1, true)
    }
  }
}

function isSchemaKey(key: string): boolean {
  return /^(model_name|modelName|model_id|modelId|name|id|key|models|model_configs|modelConfigs|children|selectables|function_model_list|functionModelList|items|list|enabled|enable|available|status|state|description|displayName|display_name|title|label)$/i.test(
    key
  )
}

function isDisabledModelEntry(value: any): boolean {
  if (
    value.enabled === false ||
    value.enable === false ||
    value.available === false ||
    value.disabled === true ||
    value.disable === true ||
    value.invisible === true
  )
    return true
  const status = String(value.status || value.state || '').toLowerCase()
  return status === 'disabled' || status === 'unavailable' || status === 'not_available'
}

function normalizeMaybeModel(value: string): string {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''
  if (
    /^(ok|success|available|enabled|disabled|unavailable|not_available|chat|default|models?|selectables?|function_model_list)$/i.test(
      trimmed
    )
  )
    return ''
  if (!/[a-z]/i.test(trimmed)) return ''
  if (
    !(
      /[-_.]/.test(trimmed) ||
      /\d/.test(trimmed) ||
      /^(gpt|gemini|deepseek|kimi|mini|max|minimax|dola|claude|qwen|llama|mistral|seed|o\d)/i.test(
        trimmed
      )
    )
  )
    return ''
  return normalizeTraeModel(trimmed)
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
