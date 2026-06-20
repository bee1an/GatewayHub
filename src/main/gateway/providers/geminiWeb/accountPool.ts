import type {
  AccountRuntimeState,
  AccountStatus,
  AccountTestResult,
  GeminiWebAccountConfig,
  GeminiWebProviderConfig,
  GeminiWebProviderState,
  ResponseKind
} from '../../types'
import { GatewayLogger } from '../../core/logger'
import { toErrorMessage } from '../../core/utils'
import {
  BaseAccountPool,
  type AccountWithState,
  type ClassifiedError
} from '../../core/accountPool'
import { GEMINI_WEB_KNOWN_MODELS } from './constants'
import { fetchAccessToken, fetchModels, rotateSidts } from './http'
import type { GeminiWebRequestContext } from './types'

export type GeminiWebAccountRuntime = AccountWithState<GeminiWebAccountConfig>

export interface GeminiWebClassifiedError extends ClassifiedError {}

const MODELS_CACHE_TTL_MS = 30 * 60_000

export class GeminiWebAccountPool extends BaseAccountPool<GeminiWebAccountConfig> {
  protected providerName = 'geminiWeb'

  constructor(
    private readonly config: GeminiWebProviderConfig,
    private readonly state: GeminiWebProviderState,
    logger: GatewayLogger,
    onStateChanged: () => void,
    private readonly persistAccount?: (
      accountId: string,
      updates: Partial<GeminiWebAccountConfig>
    ) => Promise<void>
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
   * GeminiWeb's availability check is cooldown-aware but has NO probabilistic
   * early-retry probe: a cooling account is only usable again once its cooldown
   * elapses. (auth_failed/quota_exceeded/manual_disabled stay hard-offline.)
   */
  protected isAvailable(account: GeminiWebAccountRuntime, now: number): boolean {
    if (this.isHardOffline(account.state.status)) return false
    if (
      account.state.status === 'cooling' &&
      account.state.cooldownUntil &&
      account.state.cooldownUntil > now
    )
      return false
    return true
  }

  /** GeminiWeb advances past the selected account (idx + 1) for the next rotation. */
  protected commitIndex(idx: number): void {
    const next = idx + 1
    this.currentAccountIndex = next
    this.setCurrentIndex(next)
  }

  // --- model hooks ---

  protected seedModels(): string[] {
    return [...GEMINI_WEB_KNOWN_MODELS]
  }
  protected normalizeModel(model: string): string {
    return model
  }
  /** GeminiWeb selects accounts without model filtering. */
  protected accountHasModel(_account: GeminiWebAccountRuntime, _model: string): boolean {
    return true
  }
  protected redactSecrets(config: GeminiWebAccountConfig): GeminiWebAccountConfig {
    return { ...config, cookieHeader: config.cookieHeader ? '***' : '' }
  }

  // --- reload: seed known models when an account has no cached list ---

  async reload(accountFiles: GeminiWebAccountConfig[]): Promise<void> {
    this.accounts = accountFiles.map((account) => {
      const state = this.lookupState(account.id) ?? this.defaultAccountState()
      if (!Array.isArray(state.modelIds) || !state.modelIds.length) {
        state.modelIds = [...GEMINI_WEB_KNOWN_MODELS]
        state.modelsCachedAt = Date.now()
      }
      state.modelsCachedAt = Number(state.modelsCachedAt || 0)
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

  listAccounts(): GeminiWebAccountRuntime[] {
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
      for (const model of effectiveModelIds(account.state)) set.add(model)
    }
    if (set.size === 0) return [...GEMINI_WEB_KNOWN_MODELS]
    // Stable, insertion-order enumeration; GEMINI_WEB_KNOWN_MODELS already lists
    // the preferred default first, so we keep that order instead of re-sorting.
    return [...set]
  }

  async listModelsFresh(): Promise<string[]> {
    await Promise.allSettled(
      this.accounts.filter((a) => a.config.enabled !== false).map((a) => this.maybeRefreshModels(a))
    )
    return this.listModels()
  }

  // --- account selection: no model filter, idx+1 rotation ---

  getAccount(exclude = new Set<string>()): GeminiWebAccountRuntime | undefined {
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
      // Probing the access token is the cheapest auth check: a valid session
      // returns SNlM0e; an expired cookie throws. __Secure-1PSIDTS expires
      // every few minutes, so rotate it once on auth failure before giving up.
      // The session page also carries the signed-in email (WIZ `oPEP7c`); we
      // backfill it onto the account config so the UI shows a real identifier.
      let session
      try {
        session = await fetchAccessToken(ctx)
      } catch (err) {
        const msg = toErrorMessage(err)
        if (!msg.includes('session tokens not found')) throw err
        const newSidts = await rotateSidts(ctx)
        if (!newSidts) throw err
        account.config.cookieHeader = account.config.cookieHeader
          .replace(/__Secure-1PSIDTS=[^;]+/g, `__Secure-1PSIDTS=${newSidts}`)
          .replace(/__Secure-3PSIDTS=[^;]+/g, `__Secure-3PSIDTS=${newSidts}`)
        session = await fetchAccessToken(ctx)
      }
      if (session.email && !account.config.email) {
        account.config.email = session.email
        if (this.persistAccount) {
          try {
            await this.persistAccount(account.config.id, { email: session.email })
          } catch {
            // Persistence is best-effort; the in-memory copy is already updated.
          }
        }
      }
      const models = await fetchModels(ctx).catch(() => effectiveModelIds(account.state))
      account.state.modelIds = models.length ? models : [...GEMINI_WEB_KNOWN_MODELS]
      account.state.modelsCachedAt = Date.now()
      this.transitionStatus(account, 'available', undefined)
      this.onStateChanged()
      return {
        ok: true,
        accountId,
        message: 'Gemini Web account is valid',
        models: account.state.modelIds
      }
    } catch (error) {
      const message = toErrorMessage(error)
      account.state.failures += 1
      account.state.lastFailureAt = Date.now()
      account.state.lastError = message
      this.transitionStatus(
        account,
        classifyGeminiWebError(error).kind === 'auth' ? 'auth_failed' : 'cooling',
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
      subscription: { title: 'Gemini Web', type: account.config.planType || 'web' },
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
      account.state.modelIds = models.length ? models : [...GEMINI_WEB_KNOWN_MODELS]
      account.state.modelsCachedAt = Date.now()
      this.onStateChanged()
      return { models: account.state.modelIds }
    } catch {
      account.state.modelIds = previousModels.length ? previousModels : [...GEMINI_WEB_KNOWN_MODELS]
      account.state.modelsCachedAt = Date.now()
      this.onStateChanged()
      return { models: account.state.modelIds }
    }
  }

  // --- failure reporting: geminiWeb uses a flat cooldownUntil = now + cooldownMs
  // (no exponential backoff). Override only resolveCooldown; the counter/log
  // preamble comes from BaseAccountPool. ---

  protected resolveCooldown(
    _account: GeminiWebAccountRuntime,
    classified: GeminiWebClassifiedError,
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

  buildRequestContext(account: GeminiWebAccountRuntime): GeminiWebRequestContext {
    return { account: account.config, settings: this.config.settings }
  }

  private async maybeRefreshModels(account: GeminiWebAccountRuntime): Promise<void> {
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
      if (!account.state.modelIds?.length) account.state.modelIds = [...GEMINI_WEB_KNOWN_MODELS]
      account.state.modelsCachedAt = now
      this.onStateChanged()
    }
  }
}

export function classifyGeminiWebError(error: unknown): GeminiWebClassifiedError {
  const msg = toErrorMessage(error).toLowerCase()
  if (
    msg.includes('401') ||
    msg.includes('unauthorized') ||
    msg.includes('not authenticated') ||
    msg.includes('session tokens not found') ||
    msg.includes('cookie may be invalid')
  ) {
    return { kind: 'auth', cooldownMs: 0 }
  }
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many')) {
    return { kind: 'rate_limit', cooldownMs: 60_000 }
  }
  if (
    msg.includes('403') ||
    msg.includes('cloudflare') ||
    msg.includes('challenge') ||
    msg.includes('unusual traffic')
  ) {
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

function effectiveModelIds(state: AccountRuntimeState): string[] {
  return state.modelIds?.length ? [...state.modelIds] : [...GEMINI_WEB_KNOWN_MODELS]
}

// re-exported type aliases used by consumers
export type { AccountStatus, ResponseKind }
