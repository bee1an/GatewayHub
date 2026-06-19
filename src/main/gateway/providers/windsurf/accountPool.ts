import type {
  AccountRuntimeState,
  AccountStatus,
  AccountTestResult,
  WindsurfAccountConfig,
  WindsurfProviderConfig,
  WindsurfProviderState
} from '../../types'
import type { ResponseKind } from '../../types'
import { GatewayLogger } from '../../core/logger'
import { toErrorMessage } from '../../core/utils'
import {
  BaseAccountPool,
  type AccountWithState,
  type ClassifiedError
} from '../../core/accountPool'
import { normalizeWindsurfModel } from './constants'
import { WindsurfLanguageServerClient, windsurfRuntimeDir } from './connect'
import { getWindsurfUserModels } from './cascade'

/**
 * Windsurf runtime carries an optional language-server client that is lazily
 * constructed on first use. The shared {@link AccountWithState} shape is widened
 * by this one extra field; listAccounts() clears it (clients aren't serializable).
 */
export interface WindsurfAccountRuntime extends AccountWithState<WindsurfAccountConfig> {
  client?: WindsurfLanguageServerClient
}

export interface WindsurfClassifiedError extends ClassifiedError {}

const MODELS_CACHE_TTL_MS = 30 * 60_000

export class WindsurfAccountPool extends BaseAccountPool<WindsurfAccountConfig> {
  protected providerName = 'windsurf'

  /**
   * Shadowed with the windsurf-specific runtime (carries the lazy `client`).
   * The base class declares this as `AccountWithState<C>[]`; narrowing here lets
   * windsurf-only methods reach `account.client` without casts.
   */
  declare protected accounts: WindsurfAccountRuntime[]

  private modelRefreshInFlight = new Map<string, Promise<void>>()

  constructor(
    private readonly config: WindsurfProviderConfig,
    private readonly state: WindsurfProviderState,
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

  // --- model hooks ---

  protected seedModels(): string[] {
    return []
  }
  protected normalizeModel(model: string): string {
    return normalizeWindsurfModel(model)
  }
  protected accountHasModel(account: WindsurfAccountRuntime, model: string): boolean {
    const list = account.state.modelIds || []
    if (!list.length) return true
    return list.some((available) => normalizeWindsurfModel(available) === model)
  }
  protected redactSecrets(config: WindsurfAccountConfig): WindsurfAccountConfig {
    return { ...config, apiKey: config.apiKey ? '***' : undefined }
  }
  protected accountLabel(account: WindsurfAccountRuntime): string {
    return account.config.email || account.config.label || account.config.id
  }

  // --- reload: dispose old clients, then invalidate persisted model cache ---

  async reload(accountFiles: WindsurfAccountConfig[]): Promise<void> {
    await this.dispose()
    this.accounts = accountFiles.map((account) => {
      const state = this.lookupState(account.id) ?? this.defaultAccountState()
      // Windsurf's GetUserStatus can include disabled/internal/BYOK-only model
      // configs. Older GatewayHub builds cached those raw ids, so do not trust
      // persisted Windsurf model lists across runtime reloads. The next
      // listModelsFresh/getAccountInfo call will repopulate it through the
      // current extractor.
      state.modelsCachedAt = 0
      state.modelIds = []
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

  async dispose(): Promise<void> {
    await Promise.all(this.accounts.map((a) => a.client?.dispose()))
    for (const account of this.accounts) account.client = undefined
    this.modelRefreshInFlight.clear()
  }

  /** Clear the non-serializable `client` on the redacted runtime copy. */
  listAccounts(): WindsurfAccountRuntime[] {
    return this.accounts.map((runtime) => ({
      ...runtime,
      config: this.redactSecrets(runtime.config),
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

  // --- account selection: model → availability → client (windsurf ordering) ---

  async getAccountForModel(
    model: string,
    exclude = new Set<string>()
  ): Promise<WindsurfAccountRuntime | undefined> {
    const normalizedModel = this.normalizeModel(model)
    return this.pickAccountTwoPassGeneric(exclude, async (account, relax) => {
      if (!this.accountHasModel(account, normalizedModel)) return false
      if (relax) {
        if (this.isHardOffline(account.state.status)) return false
      } else if (!this.isAvailable(account, Date.now())) {
        return false
      }
      return this.tryEnsureClient(account)
    })
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

  // --- failure reporting: windsurf uses the BaseAccountPool default
  // (auth/quota/rate_limit/cooling + cap-64 exponential backoff). ---

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

// re-exported type aliases used by consumers
export type { AccountStatus, ResponseKind }
