import type {
  AccountRuntimeState,
  AccountStatus,
  AccountTestResult,
  TraeAccountConfig,
  TraeProviderConfig,
  TraeProviderState
} from '../../types'
import { GatewayLogger } from '../../core/logger'
import { toErrorMessage } from '../../core/utils'
import {
  BaseAccountPool,
  type AccountWithState,
  type ClassifiedError
} from '../../core/accountPool'
import type { ResponseKind } from '../../types'
import { TraeAuthError, TraeAuthManager, type TraeTokenSnapshot } from './client'
import {
  DEFAULT_TRAE_MODEL,
  TRAE_BUILT_IN_MODELS,
  describeTraeModel,
  listTraeBuiltInModelIds,
  normalizeTraeModel
} from './constants'

/**
 * Trae runtime carries an optional auth manager that is constructed eagerly in
 * reload() (sync init) and whose JWT is fetched lazily on selection. The shared
 * {@link AccountWithState} shape is widened by this one extra field.
 */
export interface TraeAccountRuntime extends AccountWithState<TraeAccountConfig> {
  auth?: TraeAuthManager
}

export interface TraeClassifiedError extends ClassifiedError {}

const MODELS_CACHE_TTL_MS = 30 * 60_000

export class TraeAccountPool extends BaseAccountPool<TraeAccountConfig> {
  protected providerName = 'trae'

  /**
   * Shadowed with the trae-specific runtime (carries the `auth` manager).
   * The base class declares this as `AccountWithState<C>[]`; narrowing here lets
   * trae-only methods reach `account.auth` without casts.
   */
  declare protected accounts: TraeAccountRuntime[]

  constructor(
    private readonly config: TraeProviderConfig,
    private readonly state: TraeProviderState,
    logger: GatewayLogger,
    onStateChanged: () => void,
    private readonly persistAccount?: (
      accountId: string,
      updates: Partial<TraeAccountConfig>
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

  // --- model hooks ---

  protected seedModels(): string[] {
    return listTraeBuiltInModelIds()
  }
  protected normalizeModel(model: string): string {
    return normalizeTraeModel(model)
  }
  protected accountHasModel(account: TraeAccountRuntime, model: string): boolean {
    const list = account.state.modelIds || []
    if (!list.length) return true
    return list.some((available) => normalizeTraeModel(available) === model)
  }
  protected redactSecrets(config: TraeAccountConfig): TraeAccountConfig {
    return {
      ...config,
      jwtToken: config.jwtToken ? '***' : undefined,
      refreshToken: config.refreshToken ? '***' : undefined
    }
  }
  protected accountLabel(account: TraeAccountRuntime): string {
    return account.config.email || account.config.label || account.config.id
  }

  // --- reload: invalidate persisted model cache + eagerly construct auth managers ---

  async reload(accountFiles: TraeAccountConfig[]): Promise<void> {
    this.accounts = accountFiles.map((account) => {
      const state = this.lookupState(account.id) ?? this.defaultAccountState()
      // Older GatewayHub builds filtered the upstream model list through a
      // built-in whitelist, so persisted modelIds may be a stale subset (e.g.
      // only gemini_2.5_flash). Do not trust them across runtime reloads; the
      // next listModelsFresh/getAccountInfo call repopulates the list through
      // the current extractor. Resetting modelsCachedAt forces that refresh.
      state.modelsCachedAt = 0
      state.modelIds = []
      state.status ??= 'available'
      state.statusUpdatedAt ??= 0
      this.storeState(account.id, state)
      const runtime: TraeAccountRuntime = { config: account, state }
      this.ensureAuth(runtime)
      return runtime
    })
    const active = new Set(accountFiles.map((account) => account.id))
    for (const id of this.stateIds()) {
      if (!active.has(id)) this.deleteState(id)
    }
    this.onStateChanged()
  }

  /** Preserve the `auth` manager on the redacted runtime copy (cleared to avoid leaking it). */
  listAccounts(): TraeAccountRuntime[] {
    return this.accounts.map((runtime) => ({
      ...runtime,
      config: this.redactSecrets(runtime.config),
      auth: undefined
    }))
  }

  listModels(): string[] {
    const set = new Set<string>()
    for (const account of this.accounts) {
      if (account.config.enabled === false) continue
      const models = account.state.modelIds?.length
        ? account.state.modelIds
        : this.modelsForAccount(account.config)
      for (const model of models) set.add(model)
    }
    if (!set.size && this.config.enabled) {
      for (const model of this.modelsForAccount()) set.add(model)
    }
    return [...set].sort()
  }

  async listModelsFresh(): Promise<string[]> {
    for (const account of this.accounts) {
      if (account.config.enabled === false) continue
      await this.maybeRefreshAccountModels(account)
    }
    return this.listModels()
  }

  // --- account selection: availability → model → auth (trae ordering) ---

  async getAccountForModel(
    model: string,
    exclude = new Set<string>()
  ): Promise<TraeAccountRuntime | undefined> {
    const normalizedModel = normalizeTraeModel(model || DEFAULT_TRAE_MODEL)
    return this.pickAccountTwoPassGeneric(exclude, async (account, relax) => {
      if (relax) {
        if (this.isHardOffline(account.state.status)) return false
      } else if (!this.isAvailable(account, Date.now())) {
        return false
      }
      if (!this.accountHasModel(account, normalizedModel)) return false
      return this.tryEnsureAuth(account)
    })
  }

  async testAccount(accountId: string): Promise<AccountTestResult> {
    const account = this.accounts.find((item) => item.config.id === accountId)
    if (!account) return { ok: false, accountId, message: 'Account not found' }
    try {
      const auth = this.ensureAuth(account)
      const info = await auth.getUserInfo()
      const updates: Partial<TraeAccountConfig> = {}
      if (info.email && info.email !== account.config.email) {
        account.config.email = info.email
        updates.email = info.email
      }
      if (info.userId && info.userId !== account.config.userId) {
        account.config.userId = info.userId
        updates.userId = info.userId
      }
      if (info.countryCode && info.countryCode !== account.config.countryCode) {
        account.config.countryCode = info.countryCode
        updates.countryCode = info.countryCode
      }
      if (Object.keys(updates).length) await this.persistAccount?.(account.config.id, updates)
      await this.refreshAccountModels(account)
      this.transitionStatus(account, 'available')
      this.onStateChanged()
      return {
        ok: true,
        accountId,
        message: 'Trae account is valid',
        models: account.state.modelIds,
        expiresAt: auth.expiresAtIso,
        authType: auth.authType
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
      id: account.config.id,
      subscription: { title: 'Trae Free/Pro', type: 'unknown' },
      email: account.config.email,
      countryCode: account.config.countryCode,
      endpoints: {
        authBaseUrl: account.config.authBaseUrl || this.config.settings.authBaseUrl,
        coreBaseUrl: account.config.coreBaseUrl || this.config.settings.coreBaseUrl
      },
      models: (account.state.modelIds || []).map((model) => {
        const detail = describeTraeModel(model)
        return {
          modelId: model,
          modelName: detail?.displayName || model,
          rateMultiplier: 1,
          rateUnit: 'request',
          capabilities: detail?.capabilities,
          unavailableInUS: detail?.unavailableInUS
        }
      })
    }
  }

  async refreshAccountModelsById(accountId: string): Promise<{ models: string[] }> {
    const account = this.accounts.find((item) => item.config.id === accountId)
    if (!account) throw new Error('Account not found')
    await this.refreshAccountModels(account)
    return { models: account.state.modelIds }
  }

  // --- failure reporting: trae uses the BaseAccountPool default
  // (auth/quota/rate_limit/cooling + cap-64 exponential backoff). The
  // trae-specific transitionStatus override below still applies. ---

  // --- transitionStatus override: trae clears cooldownUntil for non-cooling states ---

  protected transitionStatus(
    account: TraeAccountRuntime,
    status: AccountStatus,
    reason?: string,
    cooldownUntil?: number
  ): void {
    account.state.status = status
    account.state.statusReason = reason
    account.state.statusUpdatedAt = Date.now()
    if (cooldownUntil) account.state.cooldownUntil = cooldownUntil
    else if (status === 'available' || status === 'manual_disabled' || status === 'auth_failed') {
      account.state.cooldownUntil = undefined
    }
  }

  private async maybeRefreshAccountModels(account: TraeAccountRuntime): Promise<void> {
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

  private async refreshAccountModels(account: TraeAccountRuntime): Promise<void> {
    let models: string[] = []
    try {
      models = await this.ensureAuth(account).getModelList()
    } catch (error) {
      this.logger.warn(`Trae model list refresh failed: ${toErrorMessage(error)}`, {
        provider: 'trae',
        accountId: this.accountLabel(account),
        category: 'account'
      })
    }
    const usableModels = sanitizeUsableModelIds(models)
    account.state.modelIds = usableModels.length
      ? usableModels
      : this.modelsForAccount(account.config)
    account.state.modelsCachedAt = Date.now()
    this.onStateChanged()
  }

  private ensureAuth(account: TraeAccountRuntime): TraeAuthManager {
    if (!account.auth) {
      account.auth = new TraeAuthManager(account.config, this.config.settings, async (snapshot) => {
        applyTokenSnapshot(account.config, snapshot)
        await this.persistAccount?.(account.config.id, snapshot)
      })
      account.auth.initialize()
    }
    return account.auth
  }

  private async tryEnsureAuth(account: TraeAccountRuntime): Promise<boolean> {
    try {
      await this.ensureAuth(account).getJwtToken()
      return true
    } catch (error) {
      account.state.lastError = toErrorMessage(error)
      account.state.lastFailureAt = Date.now()
      this.transitionStatus(account, 'auth_failed', account.state.lastError.slice(0, 200))
      this.onStateChanged()
      return false
    }
  }

  private modelsForAccount(account?: TraeAccountConfig): string[] {
    const includeUnavailableInUS =
      this.config.settings.exposeUnavailableInUS ||
      Boolean(account?.countryCode && account.countryCode !== 'US')
    return listTraeBuiltInModelIds({ includeUnavailableInUS })
  }
}

export function classifyTraeError(error: unknown): TraeClassifiedError {
  if (error instanceof TraeAuthError) return { kind: 'auth', cooldownMs: 0 }
  const raw = toErrorMessage(error)
  const msg = raw.toLowerCase()
  if (
    /code["']?:\s*1001|unauthorized|unauthenticated|invalid token|missing token|401|403|auth/.test(
      msg
    )
  )
    return { kind: 'auth', cooldownMs: 0 }
  if (/quota|usage limit|insufficient|balance|exceeded/.test(msg))
    return { kind: 'quota', cooldownMs: 60 * 60_000 }
  if (/rate limit|too many requests|429|queue|busy|high demand/.test(msg))
    return { kind: 'rate_limit', cooldownMs: 60_000 }
  if (/timeout|idle timeout/.test(msg)) return { kind: 'timeout', cooldownMs: 30_000 }
  if (/fetch failed|econnrefused|econnreset|enotfound|network/.test(msg))
    return { kind: 'network', cooldownMs: 15_000 }
  return { kind: 'server_error', cooldownMs: 30_000 }
}

export function sanitizeUsableModelIds(modelIds: string[]): string[] {
  const set = new Set<string>()
  for (const modelId of modelIds) {
    const trimmed = String(modelId || '').trim()
    if (!trimmed) continue
    set.add(normalizeTraeModel(trimmed))
  }
  return [...set].sort()
}

function applyTokenSnapshot(account: TraeAccountConfig, snapshot: TraeTokenSnapshot): void {
  if (snapshot.jwtToken) account.jwtToken = snapshot.jwtToken
  if (snapshot.refreshToken) account.refreshToken = snapshot.refreshToken
  if (snapshot.tokenExpiresAt) account.tokenExpiresAt = snapshot.tokenExpiresAt
  if (snapshot.refreshExpiresAt) account.refreshExpiresAt = snapshot.refreshExpiresAt
}

// re-exported type aliases / model docs used by consumers
export type { AccountStatus, ResponseKind }
export const TRAE_MODEL_DOCS = TRAE_BUILT_IN_MODELS
