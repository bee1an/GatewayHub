import type {
  AccountRuntimeState,
  AccountStatus,
  AccountTestResult,
  GptWebAccountConfig,
  GptWebProviderConfig,
  GptWebProviderState,
  ResponseKind
} from '../../types'
import { GatewayLogger } from '../../core/logger'
import { toErrorMessage } from '../../core/utils'
import {
  BaseAccountPool,
  type AccountWithState,
  type ClassifiedError
} from '../../core/accountPool'
import { GPT_WEB_KNOWN_MODELS } from './constants'
import { fetchModels, type GptWebRequestContext } from './http'

export type GptWebAccountRuntime = AccountWithState<GptWebAccountConfig>

export interface GptWebClassifiedError extends ClassifiedError {}

const MODELS_CACHE_TTL_MS = 30 * 60_000

export class GptWebAccountPool extends BaseAccountPool<GptWebAccountConfig> {
  protected providerName = 'gptWeb'

  constructor(
    private readonly config: GptWebProviderConfig,
    private readonly state: GptWebProviderState,
    logger: GatewayLogger,
    onStateChanged: () => void
  ) {
    super(logger, onStateChanged)
    this.currentAccountIndex = state.currentAccountIndex || 0
  }

  // --- state-store wiring ---

  protected lookupState(accountId: string): AccountRuntimeState | undefined {
    return this.state.accounts[accountId]
  }
  protected storeState(accountId: string, state: AccountRuntimeState): void {
    this.state.accounts[accountId] = state
  }
  protected deleteState(accountId: string): void {
    delete this.state.accounts[accountId]
  }
  protected stateIds(): string[] {
    return Object.keys(this.state.accounts)
  }
  protected setCurrentIndex(index: number): void {
    this.state.currentAccountIndex = index
  }

  /**
   * GptWeb's availability check is cooldown-aware but has NO probabilistic
   * early-retry probe: a cooling account is only usable again once its cooldown
   * elapses. (auth_failed/quota_exceeded/manual_disabled stay hard-offline.)
   */
  protected isAvailable(account: GptWebAccountRuntime, now: number): boolean {
    if (this.isHardOffline(account.state.status)) return false
    if (
      account.state.status === 'cooling' &&
      account.state.cooldownUntil &&
      account.state.cooldownUntil > now
    ) {
      return false
    }
    return true
  }

  /** GptWeb advances past the selected account (idx + 1) for the next rotation. */
  protected commitIndex(idx: number): void {
    const next = idx + 1
    this.currentAccountIndex = next
    this.setCurrentIndex(next)
  }

  // --- model hooks ---

  protected seedModels(): string[] {
    return []
  }
  protected normalizeModel(model: string): string {
    return model
  }
  /** GptWeb selects accounts without model filtering (it has no per-account model list). */
  protected accountHasModel(_account: GptWebAccountRuntime, _model: string): boolean {
    return true
  }
  protected redactSecrets(config: GptWebAccountConfig): GptWebAccountConfig {
    return {
      ...config,
      accessToken: config.accessToken ? '***' : undefined,
      sessionToken: config.sessionToken ? '***' : undefined
    }
  }

  // --- reload: preserve cached models; seed known models for free accounts ---

  async reload(accountFiles: GptWebAccountConfig[]): Promise<void> {
    this.accounts = accountFiles.map((account) => {
      const state = this.lookupState(account.id) ?? this.defaultAccountState()
      state.modelIds = Array.isArray(state.modelIds) ? state.modelIds : []
      state.modelsCachedAt = Number(state.modelsCachedAt || 0)
      if (isFreeAccount(account) && !state.modelIds.length) {
        state.modelIds = [...GPT_WEB_KNOWN_MODELS]
        state.modelsCachedAt = Date.now()
      }
      state.status ??= 'available'
      state.statusUpdatedAt ??= 0
      this.storeState(account.id, state)
      return { config: account, state }
    })
    const active = new Set(accountFiles.map((a) => a.id))
    for (const id of this.stateIds()) {
      if (!active.has(id)) this.deleteState(id)
    }
    this.onStateChanged()
  }

  listAccounts(): GptWebAccountRuntime[] {
    return this.accounts.map((runtime) => ({
      ...runtime,
      config: this.redactSecrets(runtime.config),
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
      for (const model of account.state.modelIds || []) set.add(model)
    }
    if (set.size === 0) return [...GPT_WEB_KNOWN_MODELS]
    return [...set].sort()
  }

  async listModelsFresh(): Promise<string[]> {
    await Promise.allSettled(
      this.accounts.filter((a) => a.config.enabled !== false).map((a) => this.maybeRefreshModels(a))
    )
    return this.listModels()
  }

  // --- account selection: no model filter, idx+1 rotation ---

  getAccount(exclude = new Set<string>()): GptWebAccountRuntime | undefined {
    return this.pickAccountTwoPassSync(exclude, (account, relax) => {
      if (relax) {
        if (this.isHardOffline(account.state.status)) return false
      } else if (!this.isAvailable(account, Date.now())) {
        return false
      }
      return true
    })
  }

  async testAccount(accountId: string): Promise<AccountTestResult> {
    const account = this.accounts.find((a) => a.config.id === accountId)
    if (!account) return { ok: false, accountId, message: 'Account not found' }
    try {
      const ctx = this.buildRequestContext(account)
      const models = await fetchModels(ctx)
      if (models.length) {
        account.state.modelIds = models
        account.state.modelsCachedAt = Date.now()
      }
      this.transitionStatus(account, 'available', undefined)
      this.onStateChanged()
      return { ok: true, accountId, message: 'GptWeb account is valid', models }
    } catch (error) {
      const message = toErrorMessage(error)
      if (shouldFallbackToKnownModels(error)) {
        const models = effectiveModelIds(account.state)
        account.state.modelIds = models
        account.state.modelsCachedAt = Date.now()
        account.state.lastError = message
        this.transitionStatus(account, 'available', 'Model discovery blocked; using known models')
        this.onStateChanged()
        return {
          ok: true,
          accountId,
          message: `GptWeb models endpoint blocked; using known models: ${message}`,
          models
        }
      }
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
    await this.maybeRefreshModels(account)
    const models = account.state.modelIds?.length ? account.state.modelIds : GPT_WEB_KNOWN_MODELS
    return {
      subscription: { title: 'GptWeb', type: account.config.planType || 'free' },
      email: account.config.email,
      models: models.map((model) => ({
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
    const previousModels = [...(account.state.modelIds || [])]
    account.state.modelsCachedAt = 0
    try {
      const models = await fetchModels(this.buildRequestContext(account))
      if (!models.length) throw new Error('GptWeb models response is empty')
      account.state.modelIds = models
      account.state.modelsCachedAt = Date.now()
      this.onStateChanged()
      return { models }
    } catch (error) {
      const fallbackModels = previousModels.length
        ? previousModels
        : shouldFallbackToKnownModels(error)
          ? [...GPT_WEB_KNOWN_MODELS]
          : []
      account.state.modelIds = fallbackModels
      account.state.modelsCachedAt = fallbackModels.length ? Date.now() : 0
      this.onStateChanged()
      if (fallbackModels.length) return { models: fallbackModels }
      throw error
    }
  }

  // --- failure reporting: gptWeb uses a flat cooldownUntil = now + cooldownMs
  // (no exponential backoff). Override only resolveCooldown; the counter/log
  // preamble comes from BaseAccountPool. ---

  protected resolveCooldown(
    _account: GptWebAccountRuntime,
    classified: GptWebClassifiedError,
    now: number
  ): { status: AccountStatus; cooldownUntil?: number } {
    const statusMap: Record<string, AccountStatus> = {
      auth: 'auth_failed',
      rate_limit: 'rate_limited',
      quota: 'quota_exceeded'
    }
    return {
      status: statusMap[classified.kind] || 'cooling',
      cooldownUntil: now + classified.cooldownMs
    }
  }

  async resetAccount(accountId: string): Promise<void> {
    const account = this.accounts.find((a) => a.config.id === accountId)
    if (!account) throw new Error('Account not found')
    account.state.failures = 0
    account.state.lastError = undefined
    account.state.cooldownUntil = undefined
    this.transitionStatus(account, 'available', undefined)
    this.onStateChanged()
  }

  async setAccountStatus(accountId: string, status: AccountStatus, reason?: string): Promise<void> {
    const account = this.accounts.find((a) => a.config.id === accountId)
    if (!account) throw new Error('Account not found')
    this.transitionStatus(account, status, reason)
    this.onStateChanged()
  }

  buildRequestContext(account: GptWebAccountRuntime): GptWebRequestContext {
    return { account: account.config, settings: this.config.settings }
  }

  // --- sync two-pass loop: gptWeb's getAccount is synchronous, so it uses the
  // shared BaseAccountPool.pickAccountTwoPassSync helper instead of the async
  // generic. ---

  private async maybeRefreshModels(account: GptWebAccountRuntime): Promise<void> {
    const now = Date.now()
    if (isFreeAccount(account.config) && isKnownFallback(account.state.modelIds)) {
      if (!account.state.modelsCachedAt) {
        account.state.modelsCachedAt = now
        this.onStateChanged()
      }
      return
    }
    if (account.state.modelsCachedAt && now - account.state.modelsCachedAt < MODELS_CACHE_TTL_MS)
      return
    try {
      const ctx = this.buildRequestContext(account)
      const models = await fetchModels(ctx)
      if (models.length) {
        account.state.modelIds = models
        account.state.modelsCachedAt = now
        this.onStateChanged()
      }
    } catch {
      // keep existing cache on failure
    }
  }
}

export function classifyGptWebError(error: unknown): GptWebClassifiedError {
  const msg = toErrorMessage(error).toLowerCase()
  if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid_token')) {
    return { kind: 'auth', cooldownMs: 0 }
  }
  if (
    msg.includes('fetch failed') ||
    msg.includes('econn') ||
    msg.includes('enotfound') ||
    msg.includes('network')
  ) {
    return { kind: 'network', cooldownMs: 15_000 }
  }
  if (
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('too many') ||
    msg.includes('unusual activity') ||
    msg.includes('turnstile') ||
    msg.includes('challenge')
  ) {
    return { kind: 'rate_limit', cooldownMs: 60_000 }
  }
  if (msg.includes('quota') || msg.includes('capacity')) {
    return { kind: 'quota', cooldownMs: 300_000 }
  }
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('aborted')) {
    return { kind: 'timeout', cooldownMs: 5_000 }
  }
  if (msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('network')) {
    return { kind: 'network', cooldownMs: 10_000 }
  }
  return { kind: 'server_error', cooldownMs: 15_000 }
}

function shouldFallbackToKnownModels(error: unknown): boolean {
  const msg = toErrorMessage(error).toLowerCase()
  if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid_token')) {
    return false
  }
  return (
    msg.includes('403') ||
    msg.includes('challenge') ||
    msg.includes('unusual activity') ||
    msg.includes('cloudflare')
  )
}

function effectiveModelIds(state: AccountRuntimeState): string[] {
  return state.modelIds?.length ? [...state.modelIds] : [...GPT_WEB_KNOWN_MODELS]
}

function isFreeAccount(account: GptWebAccountConfig): boolean {
  return (account.planType || 'free') === 'free'
}

function isKnownFallback(models?: string[]): boolean {
  if (!models?.length) return true
  const known = new Set(GPT_WEB_KNOWN_MODELS)
  return models.every((model) => known.has(model))
}

// re-exported type aliases used by consumers
export type { AccountStatus, ResponseKind }
