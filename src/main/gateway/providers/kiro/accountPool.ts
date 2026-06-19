import type {
  AccountRuntimeState,
  AccountStatus,
  AccountTestResult,
  ClassifiedKiroError,
  KiroAccountConfig,
  KiroProviderConfig,
  KiroProviderState
} from '../../types'
import type { AccountInfo, AvailableModelsResponse, UsageLimitsResponse } from './types'
import { GatewayLogger } from '../../core/logger'
import { toErrorMessage } from '../../core/utils'
import {
  BaseAccountPool,
  type AccountWithState,
  type ClassifiedError
} from '../../core/accountPool'
import { FALLBACK_MODELS, normalizeKiroModelId } from './constants'
import { KiroAuthManager } from './auth'

/**
 * Kiro runtime carries an optional auth manager that is lazily constructed on
 * first use. The shared {@link AccountWithState} shape is widened by this one
 * extra field; listAccounts() preserves it (redacted) so the provider can
 * surface authType/expiresAt without a second lookup.
 */
export interface KiroAccountRuntime extends AccountWithState<KiroAccountConfig> {
  auth?: KiroAuthManager
}

export interface KiroClassifiedError extends ClassifiedError {}

type KiroListAccount = KiroAccountRuntime & { safeConfig: KiroAccountConfig }

export class KiroAccountPool extends BaseAccountPool<KiroAccountConfig> {
  protected providerName = 'kiro'

  /**
   * Shadowed with the kiro-specific runtime (carries the lazy `auth` manager).
   * The base class declares this as `AccountWithState<C>[]`; narrowing here lets
   * kiro-only methods reach `account.auth` without casts.
   */
  declare protected accounts: KiroAccountRuntime[]

  constructor(
    private readonly config: KiroProviderConfig,
    private readonly state: KiroProviderState,
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
    return [...FALLBACK_MODELS]
  }
  protected normalizeModel(model: string): string {
    return normalizeKiroModelId(model)
  }
  protected accountHasModel(account: KiroAccountRuntime, model: string): boolean {
    return accountModels(account).some((available) => normalizeKiroModelId(available) === model)
  }
  protected redactSecrets(config: KiroAccountConfig): KiroAccountConfig {
    return {
      ...config,
      refreshToken: config.refreshToken ? '***' : undefined,
      accessToken: config.accessToken ? '***' : undefined
    }
  }
  protected accountLabel(account: KiroAccountRuntime): string {
    return account.config.email || account.config.label || account.config.id
  }

  /**
   * Kiro uses a configurable probabilistic-retry chance (settings.probabilisticRetryChance)
   * instead of the hardcoded 0.1 in the base class.
   */
  protected isAvailable(account: KiroAccountRuntime, now: number): boolean {
    const status = account.state.status
    if (status === 'available') return true
    if (this.isHardOffline(status)) return false
    // cooling / rate_limited：到期视为可用
    if (account.state.cooldownUntil && now > account.state.cooldownUntil) return true
    return Math.random() < this.config.settings.probabilisticRetryChance
  }

  // --- reload: normalize cached model ids, fall back to FALLBACK_MODELS ---

  async reload(accountFiles: KiroAccountConfig[]): Promise<void> {
    this.accounts = accountFiles.map((account) => {
      const state = this.lookupState(account.id) ?? this.defaultAccountState()
      state.modelIds = state.modelIds?.length
        ? normalizeModelIds(state.modelIds)
        : [...FALLBACK_MODELS]
      // 兼容旧状态文件：补默认值
      state.status ??= 'available'
      state.statusUpdatedAt ??= 0
      this.storeState(account.id, state)
      return { config: account, state }
    })

    const activeIds = new Set(accountFiles.map((a) => a.id))
    for (const id of this.stateIds()) {
      if (!activeIds.has(id)) this.deleteState(id)
    }

    this.onStateChanged()
  }

  /**
   * Preserve the lazy `auth` manager on the redacted runtime copy and keep the
   * legacy `safeConfig` field that the kiro provider historically reads.
   */
  listAccounts(): KiroListAccount[] {
    return this.accounts.map((runtime) => ({
      ...runtime,
      config: this.redactSecrets(runtime.config),
      safeConfig: this.redactSecrets(runtime.config)
    }))
  }

  listModels(): string[] {
    const set = new Set<string>()
    for (const account of this.accounts) {
      if (account.config.enabled === false) continue
      for (const model of accountModels(account)) set.add(model)
    }
    if (!set.size) for (const model of FALLBACK_MODELS) set.add(model)
    return [...set].sort()
  }

  // --- account selection: model → availability → auth (kiro ordering) ---

  async getAccountForModel(
    model: string,
    exclude = new Set<string>()
  ): Promise<KiroAccountRuntime | undefined> {
    const normalizedModel = this.normalizeModel(model)
    return this.pickAccountTwoPassGeneric(exclude, async (account, relax) => {
      if (!this.accountHasModel(account, normalizedModel)) return false
      if (relax) {
        if (this.isHardOffline(account.state.status)) return false
      } else if (!this.isAvailable(account, Date.now())) {
        return false
      }
      return this.tryEnsureInitialized(account)
    })
  }

  async testAccount(accountId: string): Promise<AccountTestResult> {
    const account = this.accounts.find((item) => item.config.id === accountId)
    if (!account) return { ok: false, accountId, message: 'Account not found' }
    try {
      await this.ensureInitialized(account, true)
      const token = await account.auth!.getAccessToken()
      return {
        ok: Boolean(token),
        accountId,
        message: 'Account token is valid',
        models: account.state.modelIds,
        expiresAt: account.auth!.expiresAtIso,
        authType: account.auth!.authType
      }
    } catch (error) {
      const message = toErrorMessage(error)
      account.state.lastError = message
      account.state.failures += 1
      account.state.lastFailureAt = Date.now()
      this.transitionStatus(account, 'auth_failed', message)
      this.onStateChanged()
      return { ok: false, accountId, message }
    }
  }

  // --- failure reporting: kiro diverges from the default cooldown mapping in
  // two ways — quota honors an upstream resetAtIso deadline, and cooling uses
  // max(1000, cooldownMs) as the backoff base with a configurable cap
  // (accountMaxBackoffMultiplier). Override only resolveCooldown; the
  // counter/log preamble comes from BaseAccountPool. ---

  protected resolveCooldown(
    account: KiroAccountRuntime,
    classified: ClassifiedKiroError,
    now: number
  ): { status: AccountStatus; cooldownUntil?: number } {
    switch (classified.kind) {
      case 'auth':
        return { status: 'auth_failed' }
      case 'quota':
        return {
          status: 'quota_exceeded',
          cooldownUntil: classified.resetAtIso
            ? new Date(classified.resetAtIso).getTime()
            : now + classified.cooldownMs
        }
      case 'rate_limit':
        return { status: 'rate_limited', cooldownUntil: now + classified.cooldownMs }
      default: {
        const base = Math.max(1000, classified.cooldownMs)
        const multiplier = Math.min(
          this.config.settings.accountMaxBackoffMultiplier,
          Math.pow(2, Math.max(0, account.state.failures - 1))
        )
        return { status: 'cooling', cooldownUntil: now + base * multiplier }
      }
    }
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
    this.logger.info(`Account status set to ${status}${reason ? `: ${reason}` : ''}`, {
      provider: 'kiro',
      accountId: this.accountLabel(account),
      category: 'account'
    })
    this.onStateChanged()
  }

  // --- kiro-specific API surface (unchanged) ---

  async getUsageLimits(accountId: string): Promise<UsageLimitsResponse> {
    const account = this.accounts.find((item) => item.config.id === accountId)
    if (!account) throw new Error('Account not found')
    await this.ensureInitialized(account)
    await account.auth!.ensureProfileArn()
    if (!account.auth!.profileArn) throw new Error('profileArn is not available for this account')
    return account.auth!.apiGet('/getUsageLimits', {
      profileArn: account.auth!.profileArn,
      origin: 'AI_EDITOR',
      resourceType: 'AGENTIC_REQUEST',
      isEmailRequired: 'true'
    })
  }

  private modelsCache = new Map<string, { data: AvailableModelsResponse; cachedAt: number }>()

  async listAvailableModels(
    accountId: string,
    forceRefresh = false
  ): Promise<AvailableModelsResponse> {
    const cached = this.modelsCache.get(accountId)
    if (!forceRefresh && cached) return cached.data

    const account = this.accounts.find((item) => item.config.id === accountId)
    if (!account) throw new Error('Account not found')
    try {
      await this.ensureInitialized(account)
      await account.auth!.ensureProfileArn()

      const params: Record<string, string> = { origin: 'AI_EDITOR' }
      if (account.auth!.profileArn) params.profileArn = account.auth!.profileArn

      const result = await account.auth!.apiGet('/ListAvailableModels', params)
      const modelIds = normalizeModelIds(result.models?.map((model) => model.modelId) ?? [])
      if (modelIds.length) {
        account.state.modelIds = modelIds
        account.state.modelsCachedAt = Date.now()
        this.onStateChanged()
      }
      this.modelsCache.set(accountId, { data: result, cachedAt: Date.now() })
      return result
    } catch (error) {
      const fallback = this.fallbackModelsResponse()
      if (!cached) this.modelsCache.set(accountId, { data: fallback, cachedAt: Date.now() })
      this.logger.warn(`listAvailableModels failed for ${accountId}: ${toErrorMessage(error)}`, {
        provider: 'kiro',
        accountId: this.accountLabel(account),
        category: 'account'
      })
      return cached?.data || fallback
    }
  }

  async refreshAccountModels(accountId: string): Promise<AvailableModelsResponse> {
    return this.listAvailableModels(accountId, true)
  }

  async getAccountInfo(accountId: string): Promise<AccountInfo> {
    const account = this.accounts.find((item) => item.config.id === accountId)
    if (!account) throw new Error('Account not found')

    let usage: UsageLimitsResponse | undefined
    let models: AvailableModelsResponse | undefined

    const [usageResult, modelsResult] = await Promise.allSettled([
      this.getUsageLimits(accountId),
      this.listAvailableModels(accountId)
    ])

    if (usageResult.status === 'fulfilled') usage = usageResult.value
    else
      this.logger.warn(`getUsageLimits failed for ${accountId}: ${usageResult.reason?.message}`, {
        provider: 'kiro',
        accountId: this.accountLabel(account),
        category: 'account'
      })
    if (modelsResult.status === 'fulfilled') models = modelsResult.value
    else
      this.logger.warn(
        `listAvailableModels failed for ${accountId}: ${modelsResult.reason?.message}`,
        { provider: 'kiro', accountId: this.accountLabel(account), category: 'account' }
      )

    const errors = [
      usageResult.status === 'rejected' ? usageResult.reason?.message : '',
      modelsResult.status === 'rejected' ? modelsResult.reason?.message : ''
    ]
      .filter(Boolean)
      .join('; ')

    if (!usage && !models) {
      throw new Error(errors || 'Both API calls failed')
    }
    if (errors) this.recordAccountError(account, errors)

    const breakdown = usage?.usageBreakdownList?.[0]
    return {
      subscription: usage?.subscriptionInfo || { title: 'Unknown', type: 'unknown' },
      email: usage?.userInfo?.email || undefined,
      usage: {
        used: breakdown?.currentUsage ?? 0,
        limit: breakdown?.usageLimit ?? 0,
        overages: breakdown?.currentOverages ?? 0,
        overageCap: breakdown?.overageCap ?? 0,
        overageRate: breakdown?.overageRate ?? 0,
        overageCharges: breakdown?.overageCharges ?? 0,
        resetDate: usage?.nextDateReset || ''
      },
      models: models?.models || [],
      ...(errors ? { error: errors } : {})
    }
  }

  private async tryEnsureInitialized(account: KiroAccountRuntime, force = false): Promise<boolean> {
    try {
      await this.ensureInitialized(account, force)
      return true
    } catch (error) {
      this.recordAccountError(account, error)
      return false
    }
  }

  private async ensureInitialized(account: KiroAccountRuntime, force = false): Promise<void> {
    if (account.auth && !force) return
    const auth = new KiroAuthManager(account.config, this.config.settings)
    await auth.initialize()
    account.auth = auth
    account.state.modelIds = [...FALLBACK_MODELS]
    account.state.modelsCachedAt = Date.now()
    this.logger.info(`Initialized Kiro account (${auth.authType})`, {
      provider: 'kiro',
      accountId: this.accountLabel(account),
      category: 'account'
    })
  }

  private recordAccountError(account: KiroAccountRuntime, error: unknown): void {
    account.state.failures += 1
    account.state.lastFailureAt = Date.now()
    account.state.lastError = toErrorMessage(error)
    account.state.lastResponseKind = 'auth'
    this.transitionStatus(account, 'auth_failed', account.state.lastError?.slice(0, 200))
    this.logger.warn(account.state.lastError, {
      provider: 'kiro',
      accountId: this.accountLabel(account),
      category: 'account'
    })
    this.onStateChanged()
  }

  private fallbackModelsResponse(): AvailableModelsResponse {
    return {
      models: FALLBACK_MODELS.map((id) => ({
        modelId: id,
        modelName: id,
        description: '',
        rateMultiplier: 1,
        rateUnit: 'Credit',
        tokenLimits: { inputTokenLimit: 200000, outputTokenLimit: 64000 },
        promptCaching: false
      }))
    }
  }
}

function accountModels(account: KiroAccountRuntime): string[] {
  return account.state.modelIds?.length
    ? normalizeModelIds(account.state.modelIds)
    : [...FALLBACK_MODELS]
}

function normalizeModelIds(models: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const model of models) {
    const normalized = normalizeKiroModelId(model)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}
