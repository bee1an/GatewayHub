import type {
  AccountRuntimeState,
  AccountStatus,
  AccountTestResult,
  OpenRouterAccountConfig,
  OpenRouterProviderConfig,
  OpenRouterProviderState,
  ResponseKind
} from '../../types'
import { GatewayLogger } from '../../core/logger'
import { toErrorMessage } from '../../core/utils'
import {
  OPENROUTER_BASE_URL,
  OPENROUTER_FREE_ROUTER_MODEL,
  OPENROUTER_KEY_PATH,
  OPENROUTER_MODELS_PATH
} from './constants'

export interface OpenRouterAccountRuntime {
  config: OpenRouterAccountConfig
  state: AccountRuntimeState
}

export interface OpenRouterClassifiedError {
  kind: ResponseKind
  cooldownMs: number
}

export interface OpenRouterKeyInfo {
  label?: string
  limit?: number | null
  limit_remaining?: number | null
  usage?: number
  is_free_tier?: boolean
}

interface OpenRouterModelInfo {
  id: string
  pricing?: {
    prompt?: string | number
    completion?: string | number
  }
}

const MODELS_CACHE_TTL_MS = 30 * 60_000

export class OpenRouterAccountPool {
  private accounts: OpenRouterAccountRuntime[] = []
  private currentAccountIndex = 0

  constructor(
    private readonly config: OpenRouterProviderConfig,
    private readonly state: OpenRouterProviderState,
    private readonly logger: GatewayLogger,
    private readonly onStateChanged: () => void,
    private readonly persistAccount?: (
      accountId: string,
      updates: Partial<OpenRouterAccountConfig>
    ) => Promise<void>
  ) {
    this.currentAccountIndex = state.currentAccountIndex || 0
  }

  async reload(accountFiles: OpenRouterAccountConfig[]): Promise<void> {
    this.accounts = accountFiles.map((account) => {
      const state = this.state.accounts[account.id] ?? defaultAccountState()
      state.status ??= 'available'
      state.statusUpdatedAt ??= 0
      this.state.accounts[account.id] = state
      return { config: account, state }
    })
    const active = new Set(accountFiles.map((a) => a.id))
    for (const id of Object.keys(this.state.accounts)) {
      if (!active.has(id)) delete this.state.accounts[id]
    }
    this.onStateChanged()
  }

  async dispose(): Promise<void> {
    this.accounts = []
  }

  listAccounts(): OpenRouterAccountRuntime[] {
    return this.accounts.map((runtime) => ({
      ...runtime,
      config: redactAccount(runtime.config)
    }))
  }

  listModels(): string[] {
    const set = new Set<string>()
    for (const account of this.accounts) {
      if (account.config.enabled === false) continue
      for (const model of account.state.modelIds || []) set.add(model)
    }
    return [...set].sort()
  }

  async listModelsFresh(): Promise<string[]> {
    await Promise.allSettled(
      this.accounts
        .filter((a) => a.config.enabled !== false)
        .map((a) => this.maybeRefreshAccountModels(a))
    )
    return this.listModels()
  }

  async getAccountForModel(
    model: string,
    exclude = new Set<string>()
  ): Promise<OpenRouterAccountRuntime | undefined> {
    if (!this.accounts.length) return undefined
    const now = Date.now()
    const normalizedModel = normalizeOpenRouterModel(model)
    const start = this.currentAccountIndex % this.accounts.length
    for (let i = 0; i < this.accounts.length; i++) {
      const idx = (start + i) % this.accounts.length
      const account = this.accounts[idx]
      if (account.config.enabled === false || exclude.has(account.config.id)) continue
      if (!this.isAvailable(account, now)) continue
      await this.maybeRefreshAccountModels(account)
      if (!this.accountHasModel(account, normalizedModel)) continue
      this.currentAccountIndex = idx
      this.state.currentAccountIndex = idx
      this.onStateChanged()
      return account
    }
    for (let i = 0; i < this.accounts.length; i++) {
      const idx = (start + i) % this.accounts.length
      const account = this.accounts[idx]
      if (account.config.enabled === false || exclude.has(account.config.id)) continue
      if (isHardOffline(account.state.status)) continue
      await this.maybeRefreshAccountModels(account)
      if (!this.accountHasModel(account, normalizedModel)) continue
      this.currentAccountIndex = idx
      this.state.currentAccountIndex = idx
      this.onStateChanged()
      return account
    }
    return undefined
  }

  async testAccount(accountId: string): Promise<AccountTestResult> {
    const account = this.accounts.find((a) => a.config.id === accountId)
    if (!account) return { ok: false, accountId, message: 'Account not found' }
    try {
      const { models, keyInfo } = await this.refreshAccountModels(account)
      this.transitionStatus(account, 'available', undefined)
      this.onStateChanged()
      return {
        ok: true,
        accountId,
        message: `OpenRouter key valid, ${models.length} ${keyInfo.is_free_tier ? 'free-tier' : 'paid'} model(s) available`,
        models: models.slice(0, 50),
        authType: 'openrouter-api-key'
      }
    } catch (error) {
      const message = toErrorMessage(error)
      account.state.failures += 1
      account.state.lastFailureAt = Date.now()
      account.state.lastError = message
      this.transitionStatus(account, 'auth_failed', message.slice(0, 200))
      this.onStateChanged()
      return { ok: false, accountId, message }
    }
  }

  async getAccountInfo(accountId: string): Promise<any> {
    const account = this.accounts.find((a) => a.config.id === accountId)
    if (!account) throw new Error('Account not found')
    await this.maybeRefreshAccountModels(account)
    let keyInfo: any = {}
    try {
      const baseUrl = this.config.settings.baseUrl || OPENROUTER_BASE_URL
      const res = await fetch(joinUrl(baseUrl, OPENROUTER_KEY_PATH), {
        headers: { Authorization: `Bearer ${account.config.apiKey}` }
      })
      if (res.ok) keyInfo = await res.json()
    } catch {
      /* ignore */
    }
    return {
      subscription: { title: 'OpenRouter', type: keyInfo.data?.label || 'api-key' },
      email: undefined,
      keyInfo: keyInfo.data,
      tier: account.config.isFreeTier ? 'free' : 'paid',
      limitRemaining: account.config.limitRemaining,
      models: (account.state.modelIds || []).slice(0, 100).map((model) => ({
        modelId: model,
        modelName: model,
        rateMultiplier: 1,
        rateUnit: 'request'
      }))
    }
  }

  async refreshAccountModelsById(accountId: string): Promise<{ models: string[] }> {
    const account = this.accounts.find((a) => a.config.id === accountId)
    if (!account) throw new Error('Account not found')
    account.state.modelsCachedAt = 0
    await this.refreshAccountModels(account)
    return { models: account.state.modelIds }
  }

  async reportSuccess(account: OpenRouterAccountRuntime): Promise<void> {
    account.state.failures = 0
    account.state.lastError = undefined
    account.state.lastSuccessAt = Date.now()
    account.state.stats.totalRequests += 1
    account.state.stats.successfulRequests += 1
    account.state.lastResponseKind = 'success'
    this.transitionStatus(account, 'available', undefined)
    this.onStateChanged()
  }

  async reportFailure(
    account: OpenRouterAccountRuntime,
    error: unknown,
    classified: OpenRouterClassifiedError
  ): Promise<void> {
    account.state.failures += 1
    account.state.lastFailureAt = Date.now()
    account.state.lastError = toErrorMessage(error)
    account.state.stats.totalRequests += 1
    account.state.stats.failedRequests += 1
    account.state.lastResponseKind = classified.kind
    const now = Date.now()
    const reason = account.state.lastError.slice(0, 200)
    if (classified.kind === 'auth') {
      this.transitionStatus(account, 'auth_failed', reason)
    } else if (classified.kind === 'quota') {
      this.transitionStatus(account, 'quota_exceeded', reason, now + classified.cooldownMs)
    } else if (classified.kind === 'rate_limit') {
      this.transitionStatus(account, 'rate_limited', reason, now + classified.cooldownMs)
    } else {
      const multiplier = Math.min(64, Math.pow(2, Math.max(0, account.state.failures - 1)))
      this.transitionStatus(account, 'cooling', reason, now + classified.cooldownMs * multiplier)
    }
    this.logger.warn(account.state.lastError, {
      provider: 'openrouter',
      accountId: accountLabel(account),
      category: 'account'
    })
    this.onStateChanged()
  }

  async resetAccount(accountId: string): Promise<void> {
    const account = this.accounts.find((a) => a.config.id === accountId)
    if (!account) return
    account.state.failures = 0
    account.state.lastError = undefined
    account.state.lastFailureAt = 0
    account.state.lastResponseKind = undefined
    this.transitionStatus(account, 'available', undefined)
    this.onStateChanged()
  }

  async setAccountStatus(accountId: string, status: AccountStatus, reason?: string): Promise<void> {
    const account = this.accounts.find((a) => a.config.id === accountId)
    if (!account) throw new Error(`Account not found: ${accountId}`)
    if (status === 'available') {
      account.state.failures = 0
      account.state.lastError = undefined
      account.state.cooldownUntil = undefined
    }
    this.transitionStatus(account, status, reason)
    this.onStateChanged()
  }

  private async maybeRefreshAccountModels(account: OpenRouterAccountRuntime): Promise<void> {
    const now = Date.now()
    if (
      account.state.modelsCachedAt &&
      now - account.state.modelsCachedAt < MODELS_CACHE_TTL_MS &&
      account.state.modelIds?.length
    ) {
      return
    }
    try {
      await this.refreshAccountModels(account)
    } catch (error) {
      const classified = classifyOpenRouterError(0, toErrorMessage(error))
      if (classified.kind === 'auth')
        this.transitionStatus(account, 'auth_failed', toErrorMessage(error).slice(0, 200))
      this.logger.warn(`OpenRouter model refresh failed: ${toErrorMessage(error)}`, {
        provider: 'openrouter',
        accountId: accountLabel(account),
        category: 'account'
      })
      this.onStateChanged()
    }
  }

  private async refreshAccountModels(
    account: OpenRouterAccountRuntime
  ): Promise<{ models: string[]; keyInfo: OpenRouterKeyInfo }> {
    const keyInfo = await this.fetchKeyInfo(account)
    const allModels = await this.fetchModels(account)
    const models = filterModelsForKey(allModels, keyInfo)
    account.state.modelIds = models
    account.state.modelsCachedAt = Date.now()
    applyKeyInfo(account.config, keyInfo)
    await this.persistAccount?.(account.config.id, {
      keyLabel: account.config.keyLabel,
      isFreeTier: account.config.isFreeTier,
      limit: account.config.limit,
      limitRemaining: account.config.limitRemaining,
      usage: account.config.usage,
      lastKeyInfoAt: account.config.lastKeyInfoAt
    })
    this.onStateChanged()
    return { models, keyInfo }
  }

  private async fetchKeyInfo(account: OpenRouterAccountRuntime): Promise<OpenRouterKeyInfo> {
    const baseUrl = this.config.settings.baseUrl || OPENROUTER_BASE_URL
    const res = await fetchWithTimeout(joinUrl(baseUrl, OPENROUTER_KEY_PATH), {
      headers: { Authorization: `Bearer ${account.config.apiKey}` },
      timeoutMs: 20_000
    })
    const text = await res.text()
    const payload = parseJson(text)
    if (!res.ok || payload?.error) {
      throw new Error(
        `OpenRouter key check failed: HTTP ${res.status} ${redactOpenRouterKey(text).slice(0, 500)}`
      )
    }
    return payload?.data || {}
  }

  private async fetchModels(account: OpenRouterAccountRuntime): Promise<OpenRouterModelInfo[]> {
    const baseUrl = this.config.settings.baseUrl || OPENROUTER_BASE_URL
    const res = await fetchWithTimeout(joinUrl(baseUrl, OPENROUTER_MODELS_PATH), {
      headers: { Authorization: `Bearer ${account.config.apiKey}` },
      timeoutMs: 30_000
    })
    const text = await res.text()
    const payload = parseJson(text)
    if (!res.ok || payload?.error) {
      throw new Error(
        `OpenRouter model list failed: HTTP ${res.status} ${redactOpenRouterKey(text).slice(0, 500)}`
      )
    }
    return Array.isArray(payload?.data) ? payload.data : []
  }

  private accountHasModel(account: OpenRouterAccountRuntime, model: string): boolean {
    const list = account.state.modelIds || []
    if (!list.length) return false
    return list.some((available) => normalizeOpenRouterModel(available) === model)
  }

  private isAvailable(account: OpenRouterAccountRuntime, now: number): boolean {
    const status = account.state.status
    if (status === 'available') return true
    if (isHardOffline(status)) return false
    if (account.state.cooldownUntil && now > account.state.cooldownUntil) return true
    return Math.random() < 0.1
  }

  private transitionStatus(
    account: OpenRouterAccountRuntime,
    status: AccountStatus,
    reason?: string,
    cooldownUntil?: number
  ): void {
    account.state.status = status
    account.state.statusReason = reason
    account.state.statusUpdatedAt = Date.now()
    account.state.cooldownUntil = cooldownUntil
  }
}

export function classifyOpenRouterError(status: number, body: string): OpenRouterClassifiedError {
  const msg = body.toLowerCase()
  if (status === 401 || status === 403 || /http 40[13]|invalid.*key|unauthorized/.test(msg)) {
    return { kind: 'auth', cooldownMs: 0 }
  }
  if (status === 402 || /payment required|negative credit|insufficient.*credit/.test(msg)) {
    return { kind: 'quota', cooldownMs: 60 * 60_000 }
  }
  if (status === 429 || /rate limit|too many requests/.test(msg)) {
    return { kind: 'rate_limit', cooldownMs: 60_000 }
  }
  if (/quota|credits|insufficient|exceeded/.test(msg)) {
    return { kind: 'quota', cooldownMs: 60 * 60_000 }
  }
  if (/timeout/.test(msg)) return { kind: 'timeout', cooldownMs: 30_000 }
  if (status >= 500) return { kind: 'server_error', cooldownMs: 30_000 }
  return { kind: 'server_error', cooldownMs: 15_000 }
}

function defaultAccountState(): AccountRuntimeState {
  return {
    failures: 0,
    lastFailureAt: 0,
    lastSuccessAt: 0,
    modelsCachedAt: 0,
    modelIds: [],
    status: 'available',
    statusUpdatedAt: 0,
    stats: { totalRequests: 0, successfulRequests: 0, failedRequests: 0 }
  }
}

function isHardOffline(status: AccountStatus): boolean {
  return status === 'auth_failed' || status === 'manual_disabled' || status === 'quota_exceeded'
}

function redactAccount(account: OpenRouterAccountConfig): OpenRouterAccountConfig {
  return { ...account, apiKey: account.apiKey ? '***' : undefined }
}

function accountLabel(account: OpenRouterAccountRuntime): string {
  return account.config.label || account.config.id
}

function applyKeyInfo(account: OpenRouterAccountConfig, keyInfo: OpenRouterKeyInfo): void {
  account.keyLabel = keyInfo.label || account.keyLabel
  account.isFreeTier = keyInfo.is_free_tier === true
  account.limit = keyInfo.limit ?? null
  account.limitRemaining = keyInfo.limit_remaining ?? null
  account.usage = Number(keyInfo.usage ?? account.usage ?? 0)
  account.lastKeyInfoAt = Date.now()
}

export function filterModelsForKey(
  models: OpenRouterModelInfo[],
  keyInfo: OpenRouterKeyInfo
): string[] {
  const isFreeTier = keyInfo.is_free_tier === true
  const ids = models
    .map((model) => normalizeOpenRouterModel(model.id))
    .filter((id) => id && (!isFreeTier || isFreeModelId(id)))
  if (isFreeTier) ids.push(OPENROUTER_FREE_ROUTER_MODEL)
  return [...new Set(ids)].sort()
}

function isFreeModelId(id: string): boolean {
  return (
    id.endsWith(':free') || id === OPENROUTER_FREE_ROUTER_MODEL || id === 'openrouter/auto:free'
  )
}

function normalizeOpenRouterModel(model: string): string {
  return String(model || '').trim()
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

async function fetchWithTimeout(
  url: string,
  options: { headers?: Record<string, string>; timeoutMs: number }
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    return await fetch(url, { headers: options.headers, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function parseJson(text: string): any {
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { rawText: text }
  }
}

function redactOpenRouterKey(text: string): string {
  return text.replace(/sk-or-v1-[A-Za-z0-9_-]+/g, 'sk-or-v1-***')
}
