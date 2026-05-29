import type {
  AccountRuntimeState,
  AccountStatus,
  AccountTestResult,
  ResponseKind,
  WindsurfAccountConfig,
  WindsurfProviderConfig,
  WindsurfProviderState
} from '../../types'
import { GatewayLogger } from '../../core/logger'
import { toErrorMessage } from '../../core/utils'
import { normalizeWindsurfModel } from './constants'
import { WindsurfLanguageServerClient, windsurfRuntimeDir } from './connect'
import { getWindsurfUserModels } from './cascade'

export interface WindsurfAccountRuntime {
  config: WindsurfAccountConfig
  state: AccountRuntimeState
  client?: WindsurfLanguageServerClient
}

export interface WindsurfClassifiedError {
  kind: ResponseKind
  cooldownMs: number
}

const MODELS_CACHE_TTL_MS = 30 * 60_000

export class WindsurfAccountPool {
  private accounts: WindsurfAccountRuntime[] = []
  private currentAccountIndex = 0
  private modelRefreshInFlight = new Map<string, Promise<void>>()

  constructor(
    private readonly config: WindsurfProviderConfig,
    private readonly state: WindsurfProviderState,
    private readonly logger: GatewayLogger,
    private readonly onStateChanged: () => void
  ) {
    this.currentAccountIndex = state.currentAccountIndex || 0
  }

  async reload(accountFiles: WindsurfAccountConfig[]): Promise<void> {
    await this.dispose()
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
    await Promise.all(this.accounts.map((a) => a.client?.dispose()))
    for (const account of this.accounts) account.client = undefined
    this.modelRefreshInFlight.clear()
  }

  listAccounts(): WindsurfAccountRuntime[] {
    return this.accounts.map((runtime) => ({
      ...runtime,
      config: redactAccount(runtime.config),
      client: undefined
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
        .filter((account) => account.config.enabled !== false)
        .map((account) => this.maybeRefreshAccountModels(account))
    )
    return this.listModels()
  }

  async getAccountForModel(
    model: string,
    exclude = new Set<string>()
  ): Promise<WindsurfAccountRuntime | undefined> {
    if (!this.accounts.length) return undefined
    const now = Date.now()
    const normalized = normalizeWindsurfModel(model)
    const start = this.currentAccountIndex % this.accounts.length
    for (let i = 0; i < this.accounts.length; i++) {
      const idx = (start + i) % this.accounts.length
      const account = this.accounts[idx]
      if (account.config.enabled === false || exclude.has(account.config.id)) continue
      if (!this.accountHasModel(account, normalized)) continue
      if (!this.isAvailable(account, now)) continue
      if (!(await this.tryEnsureClient(account))) continue
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
      if (!this.accountHasModel(account, normalized)) continue
      if (!(await this.tryEnsureClient(account))) continue
      this.currentAccountIndex = idx
      this.state.currentAccountIndex = idx
      this.onStateChanged()
      return account
    }
    return undefined
  }

  async testAccount(accountId: string): Promise<AccountTestResult> {
    const account = this.accounts.find((item) => item.config.id === accountId)
    if (!account) return { ok: false, accountId, message: 'Account not found' }
    try {
      await this.ensureClient(account)
      await this.refreshAccountModels(account)
      return {
        ok: true,
        accountId,
        message: 'Windsurf account is valid',
        models: account.state.modelIds,
        authType: account.config.authType || 'windsurf-api-key'
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
    const account = this.accounts.find((item) => item.config.id === accountId)
    if (!account) throw new Error('Account not found')
    await this.maybeRefreshAccountModels(account)
    return {
      subscription: { title: 'Windsurf', type: 'unknown' },
      email: account.config.email,
      models: (account.state.modelIds || []).map((model) => ({
        modelId: model,
        modelName: model,
        rateMultiplier: 1,
        rateUnit: 'request'
      }))
    }
  }

  async refreshAccountModelsById(accountId: string): Promise<{ models: string[] }> {
    const account = this.accounts.find((item) => item.config.id === accountId)
    if (!account) throw new Error('Account not found')
    account.state.modelsCachedAt = 0
    await this.refreshAccountModels(account)
    return { models: account.state.modelIds }
  }

  async reportSuccess(account: WindsurfAccountRuntime): Promise<void> {
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
    account: WindsurfAccountRuntime,
    error: unknown,
    classified: WindsurfClassifiedError
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
      provider: 'windsurf',
      accountId: accountLabel(account),
      category: 'account'
    })
    this.onStateChanged()
  }

  async resetAccount(accountId: string): Promise<void> {
    const account = this.accounts.find((item) => item.config.id === accountId)
    if (!account) return
    account.state.failures = 0
    account.state.lastError = undefined
    account.state.lastFailureAt = 0
    account.state.lastResponseKind = undefined
    this.transitionStatus(account, 'available', undefined)
    this.onStateChanged()
  }

  async setAccountStatus(accountId: string, status: AccountStatus, reason?: string): Promise<void> {
    const account = this.accounts.find((item) => item.config.id === accountId)
    if (!account) throw new Error(`Account not found: ${accountId}`)
    if (status === 'available') {
      account.state.failures = 0
      account.state.lastError = undefined
      account.state.cooldownUntil = undefined
    }
    this.transitionStatus(account, status, reason)
    this.onStateChanged()
  }

  private async maybeRefreshAccountModels(account: WindsurfAccountRuntime): Promise<void> {
    const now = Date.now()
    if (
      account.state.modelsCachedAt &&
      now - account.state.modelsCachedAt < MODELS_CACHE_TTL_MS &&
      account.state.modelIds?.length
    ) {
      return
    }
    await this.refreshAccountModels(account)
  }

  private async refreshAccountModels(account: WindsurfAccountRuntime): Promise<void> {
    const inflight = this.modelRefreshInFlight.get(account.config.id)
    if (inflight) return inflight
    const job = (async () => {
      try {
        await this.ensureClient(account)
        const models = (await getWindsurfUserModels(account.client!, this.config.settings)).map(
          normalizeWindsurfModel
        )
        account.state.modelIds = models.length ? [...new Set(models)].sort() : []
        account.state.modelsCachedAt = Date.now()
        this.onStateChanged()
      } finally {
        this.modelRefreshInFlight.delete(account.config.id)
      }
    })()
    this.modelRefreshInFlight.set(account.config.id, job)
    return job
  }

  private async tryEnsureClient(account: WindsurfAccountRuntime): Promise<boolean> {
    try {
      await this.ensureClient(account)
      return true
    } catch (error) {
      account.state.lastError = toErrorMessage(error)
      account.state.lastFailureAt = Date.now()
      this.transitionStatus(account, 'auth_failed', account.state.lastError.slice(0, 200))
      this.onStateChanged()
      return false
    }
  }

  private async ensureClient(account: WindsurfAccountRuntime): Promise<void> {
    if (!account.config.apiKey) throw new Error('Missing Windsurf apiKey/accessToken')
    if (!account.client) {
      account.client = new WindsurfLanguageServerClient(
        account.config,
        this.config.settings,
        windsurfRuntimeDir(account.config.id)
      )
    }
    await account.client.ensureStarted()
  }

  private accountHasModel(account: WindsurfAccountRuntime, model: string): boolean {
    const list = account.state.modelIds || []
    if (!list.length) return true
    const normalized = normalizeWindsurfModel(model)
    return list.some((available) => normalizeWindsurfModel(available) === normalized)
  }

  private isAvailable(account: WindsurfAccountRuntime, now: number): boolean {
    const status = account.state.status
    if (status === 'available') return true
    if (isHardOffline(status)) return false
    if (account.state.cooldownUntil && now > account.state.cooldownUntil) return true
    return Math.random() < 0.1
  }

  private transitionStatus(
    account: WindsurfAccountRuntime,
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

export function classifyWindsurfError(error: unknown): WindsurfClassifiedError {
  const raw = toErrorMessage(error)
  const msg = raw.toLowerCase()
  if (/high demand|try again later|temporarily unavailable|overloaded/.test(msg)) {
    return { kind: 'rate_limit', cooldownMs: 60_000 }
  }
  // quota/rate_limit 必须在 auth 之前判定：诸如 "api key has exceeded its quota" 这类
  // 限流消息也含 "api key"，若先匹配 auth 会被误判为永久 auth_failed 而停止重试。
  if (/quota|usage limit|exceeded/.test(msg)) return { kind: 'quota', cooldownMs: 60 * 60_000 }
  if (/rate limit|429|too many requests/.test(msg)) {
    return { kind: 'rate_limit', cooldownMs: 60_000 }
  }
  if (/unauthenticated|invalid api key|missing api key|unauthorized|401|403/.test(msg)) {
    return { kind: 'auth', cooldownMs: 0 }
  }
  if (/timeout/.test(msg)) return { kind: 'timeout', cooldownMs: 30_000 }
  if (/fetch failed|econnrefused|econnreset|enotfound|network/.test(msg)) {
    return { kind: 'network', cooldownMs: 15_000 }
  }
  return { kind: 'server_error', cooldownMs: 30_000 }
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
    stats: {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0
    }
  }
}

function isHardOffline(status: AccountStatus): boolean {
  return status === 'auth_failed' || status === 'manual_disabled' || status === 'quota_exceeded'
}

function redactAccount(account: WindsurfAccountConfig): WindsurfAccountConfig {
  return { ...account, apiKey: account.apiKey ? '***' : undefined }
}

function accountLabel(account: WindsurfAccountRuntime): string {
  return account.config.email || account.config.label || account.config.id
}
