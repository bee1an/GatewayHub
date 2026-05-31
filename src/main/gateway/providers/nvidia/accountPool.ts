import type {
  AccountRuntimeState,
  AccountStatus,
  AccountTestResult,
  NvidiaAccountConfig,
  NvidiaProviderConfig,
  NvidiaProviderState,
  ResponseKind
} from '../../types'
import { GatewayLogger } from '../../core/logger'
import { toErrorMessage } from '../../core/utils'
import { NVIDIA_BASE_URL, NVIDIA_DEFAULT_SMOKE_MODEL, NVIDIA_MODELS_PATH } from './constants'

export interface NvidiaAccountRuntime {
  config: NvidiaAccountConfig
  state: AccountRuntimeState
}

export interface NvidiaClassifiedError {
  kind: ResponseKind
  cooldownMs: number
}

export interface NvidiaKeyInfo {
  label?: string
  checkedAt?: number
}

interface NvidiaModelInfo {
  id: string
  owned_by?: string
  object?: string
}

const MODELS_CACHE_TTL_MS = 30 * 60_000

export class NvidiaAccountPool {
  private accounts: NvidiaAccountRuntime[] = []
  private currentAccountIndex = 0

  constructor(
    private readonly config: NvidiaProviderConfig,
    private readonly state: NvidiaProviderState,
    private readonly logger: GatewayLogger,
    private readonly onStateChanged: () => void,
    private readonly persistAccount?: (
      accountId: string,
      updates: Partial<NvidiaAccountConfig>
    ) => Promise<void>
  ) {
    this.currentAccountIndex = state.currentAccountIndex || 0
  }

  async reload(accountFiles: NvidiaAccountConfig[]): Promise<void> {
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

  listAccounts(): NvidiaAccountRuntime[] {
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
  ): Promise<NvidiaAccountRuntime | undefined> {
    if (!this.accounts.length) return undefined
    const now = Date.now()
    const normalizedModel = normalizeNvidiaModel(model)
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
      await this.checkApiKey(account)
      const { models } = await this.refreshAccountModels(account)
      this.transitionStatus(account, 'available', undefined)
      this.onStateChanged()
      return {
        ok: true,
        accountId,
        message: `NVIDIA key valid, ${models.length} model(s) discovered from /models`,
        models: models.slice(0, 50),
        authType: 'nvidia-api-key'
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
    return {
      subscription: { title: 'NVIDIA NIM', type: account.config.keyLabel || 'api-key' },
      email: undefined,
      keyInfo: {
        baseUrl: this.config.settings.baseUrl || NVIDIA_BASE_URL,
        lastKeyInfoAt: account.config.lastKeyInfoAt
      },
      tier: 'api-key',
      limitRemaining: undefined,
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

  async reportSuccess(account: NvidiaAccountRuntime): Promise<void> {
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
    account: NvidiaAccountRuntime,
    error: unknown,
    classified: NvidiaClassifiedError
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
      provider: 'nvidia',
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

  private async maybeRefreshAccountModels(account: NvidiaAccountRuntime): Promise<void> {
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
      const classified = classifyNvidiaError(0, toErrorMessage(error))
      if (classified.kind === 'auth')
        this.transitionStatus(account, 'auth_failed', toErrorMessage(error).slice(0, 200))
      this.logger.warn(`NVIDIA model refresh failed: ${toErrorMessage(error)}`, {
        provider: 'nvidia',
        accountId: accountLabel(account),
        category: 'account'
      })
      this.onStateChanged()
    }
  }

  private async refreshAccountModels(
    account: NvidiaAccountRuntime
  ): Promise<{ models: string[]; keyInfo: NvidiaKeyInfo }> {
    const allModels = await this.fetchModels(account)
    const models = filterModelsForKey(allModels)
    account.state.modelIds = models
    account.state.modelsCachedAt = Date.now()
    const keyInfo: NvidiaKeyInfo = {
      label: account.config.keyLabel || 'NVIDIA NIM',
      checkedAt: Date.now()
    }
    applyKeyInfo(account.config, keyInfo)
    await this.persistAccount?.(account.config.id, {
      keyLabel: account.config.keyLabel,
      lastKeyInfoAt: account.config.lastKeyInfoAt
    })
    this.onStateChanged()
    return { models, keyInfo }
  }

  private async fetchModels(account: NvidiaAccountRuntime): Promise<NvidiaModelInfo[]> {
    const baseUrl = this.config.settings.baseUrl || NVIDIA_BASE_URL
    const res = await fetchWithTimeout(joinUrl(baseUrl, NVIDIA_MODELS_PATH), {
      headers: { Authorization: `Bearer ${account.config.apiKey}` },
      timeoutMs: 30_000
    })
    const text = await res.text()
    const payload = parseJson(text)
    if (!res.ok || payload?.error) {
      throw new Error(
        `NVIDIA model list failed: HTTP ${res.status} ${redactNvidiaKey(text).slice(0, 500)}`
      )
    }
    return Array.isArray(payload?.data) ? payload.data : []
  }

  private async checkApiKey(account: NvidiaAccountRuntime): Promise<void> {
    const baseUrl = this.config.settings.baseUrl || NVIDIA_BASE_URL
    const res = await fetchWithTimeout(joinUrl(baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${account.config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: NVIDIA_DEFAULT_SMOKE_MODEL,
        max_tokens: 1,
        stream: false,
        messages: [{ role: 'user', content: 'Reply OK.' }]
      }),
      timeoutMs: this.config.settings.firstTokenTimeoutSeconds * 1000
    })
    const text = await res.text()
    const payload = parseJson(text)
    if (!res.ok || payload?.error) {
      throw new Error(
        `NVIDIA key check failed: HTTP ${res.status} ${redactNvidiaKey(text).slice(0, 500)}`
      )
    }
  }

  private accountHasModel(account: NvidiaAccountRuntime, model: string): boolean {
    const list = account.state.modelIds || []
    if (!list.length) return false
    return list.some((available) => normalizeNvidiaModel(available) === model)
  }

  private isAvailable(account: NvidiaAccountRuntime, now: number): boolean {
    const status = account.state.status
    if (status === 'available') return true
    if (isHardOffline(status)) return false
    if (account.state.cooldownUntil && now > account.state.cooldownUntil) return true
    return Math.random() < 0.1
  }

  private transitionStatus(
    account: NvidiaAccountRuntime,
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

export function classifyNvidiaError(status: number, body: string): NvidiaClassifiedError {
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

function redactAccount(account: NvidiaAccountConfig): NvidiaAccountConfig {
  return { ...account, apiKey: account.apiKey ? '***' : undefined }
}

function accountLabel(account: NvidiaAccountRuntime): string {
  return account.config.label || account.config.id
}

function applyKeyInfo(account: NvidiaAccountConfig, keyInfo: NvidiaKeyInfo): void {
  account.keyLabel = keyInfo.label || account.keyLabel
  account.lastKeyInfoAt = keyInfo.checkedAt ?? Date.now()
}

export function filterModelsForKey(models: NvidiaModelInfo[]): string[] {
  const ids = models
    .map((model) => normalizeNvidiaModel(model.id))
    .filter((id) => id && !isNonChatCatalogModel(id))
  return [...new Set(ids)].sort()
}

function isNonChatCatalogModel(id: string): boolean {
  return /(?:^|[/_.-])(bge|deplot|detector|embed|embedding|fuyu|flux|image|kosmos|multimodal|neva|nvclip|parse|rerank|retriever|reward|video|vision|vila|vl)(?:$|[/_.-])/.test(
    id
  )
}

function normalizeNvidiaModel(model: string): string {
  return String(model || '').trim()
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

async function fetchWithTimeout(
  url: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: string
    timeoutMs: number
  }
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    return await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: controller.signal
    })
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

function redactNvidiaKey(text: string): string {
  return text
    .replace(/nvapi-[A-Za-z0-9._-]+/g, 'nvapi-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
}
