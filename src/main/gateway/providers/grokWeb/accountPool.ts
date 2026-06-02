import type {
  AccountRuntimeState,
  AccountStatus,
  AccountTestResult,
  GrokWebAccountConfig,
  GrokWebProviderConfig,
  GrokWebProviderState,
  ResponseKind
} from '../../types'
import { GatewayLogger } from '../../core/logger'
import { toErrorMessage } from '../../core/utils'
import { GROK_WEB_KNOWN_MODELS } from './constants'
import { fetchModels, fetchUser, type GrokWebRequestContext } from './http'

export interface GrokWebAccountRuntime {
  config: GrokWebAccountConfig
  state: AccountRuntimeState
}

export interface GrokWebClassifiedError {
  kind: ResponseKind
  cooldownMs: number
}

const MODELS_CACHE_TTL_MS = 30 * 60_000

export class GrokWebAccountPool {
  private accounts: GrokWebAccountRuntime[] = []
  private currentAccountIndex = 0

  constructor(
    private readonly config: GrokWebProviderConfig,
    private readonly state: GrokWebProviderState,
    _logger: GatewayLogger,
    private readonly onStateChanged: () => void
  ) {
    this.currentAccountIndex = state.currentAccountIndex || 0
  }

  async reload(accountFiles: GrokWebAccountConfig[]): Promise<void> {
    this.accounts = accountFiles.map((account) => {
      const state = this.state.accounts[account.id] ?? defaultAccountState()
      if (!Array.isArray(state.modelIds) || !state.modelIds.length) {
        state.modelIds = [...GROK_WEB_KNOWN_MODELS]
        state.modelsCachedAt = Date.now()
      }
      state.modelsCachedAt = Number(state.modelsCachedAt || 0)
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

  dispose(): void {
    this.accounts = []
  }

  listAccounts(): GrokWebAccountRuntime[] {
    return this.accounts.map((runtime) => ({
      ...runtime,
      config: redactAccount(runtime.config),
      state: {
        ...runtime.state,
        stats: { ...runtime.state.stats },
        modelIds: effectiveModelIds(runtime.state)
      }
    }))
  }

  listModels(): string[] {
    const set = new Set<string>()
    for (const account of this.accounts) {
      if (account.config.enabled === false) continue
      for (const model of effectiveModelIds(account.state)) set.add(model)
    }
    if (set.size === 0) return [...GROK_WEB_KNOWN_MODELS]
    return [...set].sort((a, b) => (a === 'auto' ? -1 : b === 'auto' ? 1 : a.localeCompare(b)))
  }

  async listModelsFresh(): Promise<string[]> {
    await Promise.allSettled(
      this.accounts.filter((a) => a.config.enabled !== false).map((a) => this.maybeRefreshModels(a))
    )
    return this.listModels()
  }

  getAccount(exclude = new Set<string>()): GrokWebAccountRuntime | undefined {
    if (!this.accounts.length) return undefined
    const now = Date.now()
    const start = this.currentAccountIndex % this.accounts.length

    for (let i = 0; i < this.accounts.length; i++) {
      const idx = (start + i) % this.accounts.length
      const account = this.accounts[idx]
      if (account.config.enabled === false || exclude.has(account.config.id)) continue
      if (!this.isAvailable(account, now)) continue
      this.currentAccountIndex = idx + 1
      this.state.currentAccountIndex = this.currentAccountIndex
      this.onStateChanged()
      return account
    }

    for (let i = 0; i < this.accounts.length; i++) {
      const idx = (start + i) % this.accounts.length
      const account = this.accounts[idx]
      if (account.config.enabled === false || exclude.has(account.config.id)) continue
      if (isHardOffline(account.state.status)) continue
      this.currentAccountIndex = idx + 1
      this.state.currentAccountIndex = this.currentAccountIndex
      this.onStateChanged()
      return account
    }

    return undefined
  }

  async testAccount(accountId: string): Promise<AccountTestResult> {
    const account = this.accounts.find((a) => a.config.id === accountId)
    if (!account) return { ok: false, accountId, message: 'Account not found' }
    try {
      const ctx = this.buildRequestContext(account)
      const user = await fetchUser(ctx)
      if (user.email) account.config.email = user.email
      if (user.userId) account.config.userId = user.userId
      const models = await fetchModels(ctx).catch(() => effectiveModelIds(account.state))
      account.state.modelIds = models.length ? models : [...GROK_WEB_KNOWN_MODELS]
      account.state.modelsCachedAt = Date.now()
      this.transitionStatus(account, 'available', undefined)
      this.onStateChanged()
      return {
        ok: true,
        accountId,
        message: 'Grok Web account is valid',
        models: account.state.modelIds
      }
    } catch (error) {
      const message = toErrorMessage(error)
      account.state.failures += 1
      account.state.lastFailureAt = Date.now()
      account.state.lastError = message
      this.transitionStatus(
        account,
        classifyGrokWebError(error).kind === 'auth' ? 'auth_failed' : 'cooling',
        message.slice(0, 200)
      )
      this.onStateChanged()
      return { ok: false, accountId, message }
    }
  }

  async getAccountInfo(accountId: string): Promise<any> {
    const account = this.accounts.find((a) => a.config.id === accountId)
    if (!account) throw new Error('Account not found')
    await this.maybeRefreshModels(account)
    return {
      subscription: { title: 'Grok Web', type: account.config.planType || 'web' },
      email: account.config.email,
      models: effectiveModelIds(account.state).map((model) => ({
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
    const previousModels = effectiveModelIds(account.state)
    account.state.modelsCachedAt = 0
    try {
      const models = await fetchModels(this.buildRequestContext(account))
      account.state.modelIds = models.length ? models : [...GROK_WEB_KNOWN_MODELS]
      account.state.modelsCachedAt = Date.now()
      this.onStateChanged()
      return { models: account.state.modelIds }
    } catch {
      account.state.modelIds = previousModels.length ? previousModels : [...GROK_WEB_KNOWN_MODELS]
      account.state.modelsCachedAt = Date.now()
      this.onStateChanged()
      return { models: account.state.modelIds }
    }
  }

  reportSuccess(account: GrokWebAccountRuntime): void {
    account.state.failures = 0
    account.state.lastError = undefined
    account.state.lastSuccessAt = Date.now()
    account.state.stats.totalRequests += 1
    account.state.stats.successfulRequests += 1
    account.state.lastResponseKind = 'success'
    this.transitionStatus(account, 'available', undefined)
    this.onStateChanged()
  }

  reportFailure(
    account: GrokWebAccountRuntime,
    error: unknown,
    classified: GrokWebClassifiedError
  ): void {
    account.state.failures += 1
    account.state.lastFailureAt = Date.now()
    account.state.lastError = toErrorMessage(error)
    account.state.stats.totalRequests += 1
    account.state.stats.failedRequests += 1
    account.state.lastResponseKind = classified.kind
    const statusMap: Record<string, AccountStatus> = {
      auth: 'auth_failed',
      rate_limit: 'rate_limited',
      quota: 'quota_exceeded'
    }
    const newStatus = statusMap[classified.kind] || 'cooling'
    account.state.cooldownUntil = Date.now() + classified.cooldownMs
    this.transitionStatus(account, newStatus, account.state.lastError?.slice(0, 200))
    this.onStateChanged()
  }

  resetAccount(accountId: string): void {
    const account = this.accounts.find((a) => a.config.id === accountId)
    if (!account) throw new Error('Account not found')
    account.state.failures = 0
    account.state.lastError = undefined
    account.state.cooldownUntil = undefined
    this.transitionStatus(account, 'available', undefined)
    this.onStateChanged()
  }

  setAccountStatus(accountId: string, status: AccountStatus, reason?: string): void {
    const account = this.accounts.find((a) => a.config.id === accountId)
    if (!account) throw new Error('Account not found')
    this.transitionStatus(account, status, reason)
    this.onStateChanged()
  }

  buildRequestContext(account: GrokWebAccountRuntime): GrokWebRequestContext {
    return { account: account.config, settings: this.config.settings }
  }

  private isAvailable(account: GrokWebAccountRuntime, now: number): boolean {
    if (isHardOffline(account.state.status)) return false
    if (
      account.state.status === 'cooling' &&
      account.state.cooldownUntil &&
      account.state.cooldownUntil > now
    )
      return false
    return true
  }

  private transitionStatus(
    account: GrokWebAccountRuntime,
    status: AccountStatus,
    reason?: string
  ): void {
    account.state.status = status
    account.state.statusReason = reason
    account.state.statusUpdatedAt = Date.now()
  }

  private async maybeRefreshModels(account: GrokWebAccountRuntime): Promise<void> {
    const now = Date.now()
    if (account.state.modelsCachedAt && now - account.state.modelsCachedAt < MODELS_CACHE_TTL_MS)
      return
    try {
      const models = await fetchModels(this.buildRequestContext(account))
      if (models.length) {
        account.state.modelIds = models
        account.state.modelsCachedAt = now
        this.onStateChanged()
      }
    } catch {
      if (!account.state.modelIds?.length) account.state.modelIds = [...GROK_WEB_KNOWN_MODELS]
      account.state.modelsCachedAt = now
      this.onStateChanged()
    }
  }
}

export function classifyGrokWebError(error: unknown): GrokWebClassifiedError {
  const msg = toErrorMessage(error).toLowerCase()
  if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('not authenticated')) {
    return { kind: 'auth', cooldownMs: 0 }
  }
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many')) {
    return { kind: 'rate_limit', cooldownMs: 60_000 }
  }
  if (msg.includes('403') || msg.includes('cloudflare') || msg.includes('challenge')) {
    return { kind: 'rate_limit', cooldownMs: 60_000 }
  }
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('aborted')) {
    return { kind: 'timeout', cooldownMs: 5_000 }
  }
  if (
    msg.includes('fetch failed') ||
    msg.includes('econn') ||
    msg.includes('enotfound') ||
    msg.includes('network')
  ) {
    return { kind: 'network', cooldownMs: 15_000 }
  }
  if (msg.includes('quota') || msg.includes('capacity')) {
    return { kind: 'quota', cooldownMs: 300_000 }
  }
  return { kind: 'server_error', cooldownMs: 15_000 }
}

function isHardOffline(status?: AccountStatus): boolean {
  return status === 'auth_failed' || status === 'quota_exceeded' || status === 'manual_disabled'
}

function effectiveModelIds(state: AccountRuntimeState): string[] {
  return state.modelIds?.length ? [...state.modelIds] : [...GROK_WEB_KNOWN_MODELS]
}

function defaultAccountState(): AccountRuntimeState {
  return {
    failures: 0,
    lastFailureAt: 0,
    lastSuccessAt: 0,
    modelsCachedAt: 0,
    modelIds: [...GROK_WEB_KNOWN_MODELS],
    status: 'available',
    statusUpdatedAt: 0,
    stats: { totalRequests: 0, successfulRequests: 0, failedRequests: 0 }
  }
}

function redactAccount(config: GrokWebAccountConfig): GrokWebAccountConfig {
  return { ...config, cookieHeader: config.cookieHeader ? '***' : '' }
}
