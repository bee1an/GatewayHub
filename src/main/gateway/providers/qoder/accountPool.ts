import type {
  AccountRuntimeState,
  AccountStatus,
  AccountTestResult,
  QoderAccountConfig,
  QoderProviderConfig,
  QoderProviderState,
  ResponseKind
} from '../../types'
import { GatewayLogger } from '../../core/logger'
import { toErrorMessage } from '../../core/utils'
import {
  BaseAccountPool,
  type AccountWithState,
  type ClassifiedError
} from '../../core/accountPool'
import {
  QODER_DIRECT_MODEL_IDS,
  QODER_KNOWN_MODEL_IDS,
  isQoderLegacyModel,
  normalizeQoderModel
} from './constants'
import {
  fetchQoderAccountProfile,
  listQoderDirectModels,
  qoderAccountUsesDirectApi,
  streamQoderChatCompletion
} from './client'

export type QoderAccountRuntime = AccountWithState<QoderAccountConfig>

export interface QoderClassifiedError extends ClassifiedError {}

const MODELS_CACHE_TTL_MS = 30 * 60_000

export class QoderAccountPool extends BaseAccountPool<QoderAccountConfig> {
  protected providerName = 'qoder'

  constructor(
    private readonly config: QoderProviderConfig,
    private readonly state: QoderProviderState,
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
   * Qoder does NOT treat quota_exceeded as hard-offline: a quota'd account can
   * still recover once its quota window resets, so it stays in the relaxed pass.
   */
  protected isHardOffline(status: AccountStatus): boolean {
    return status === 'auth_failed' || status === 'manual_disabled'
  }

  /**
   * Qoder's availability check is cooldown-aware but has NO probabilistic
   * early-retry probe: a cooling/rate-limited/quota'd account is only usable
   * again once its cooldown elapses.
   */
  protected isAvailable(account: QoderAccountRuntime, now: number): boolean {
    const status = account.state.status
    if (this.isHardOffline(status)) return false
    if (
      (status === 'cooling' || status === 'rate_limited' || status === 'quota_exceeded') &&
      account.state.cooldownUntil &&
      account.state.cooldownUntil > now
    ) {
      return false
    }
    return true
  }

  /** Qoder advances past the selected account (idx + 1) for the next rotation. */
  protected commitIndex(idx: number): void {
    const next = idx + 1
    this.currentAccountIndex = next
    this.setCurrentIndex(next)
  }

  // --- model hooks ---

  protected seedModels(): string[] {
    return [...QODER_KNOWN_MODEL_IDS]
  }
  protected normalizeModel(model: string): string {
    return normalizeQoderModel(model)
  }
  /**
   * Routing decision for a (possibly client-supplied) model id.
   *  - CLI-gated legacy models require a managed qodercli bundle.
   *  - Empty cache: accept anything (we don't know yet; the upstream will surface a real error if it rejects the id).
   *  - Cached list hit: accept.
   *  - Any id not in QODER_KNOWN_MODEL_IDS is forwarded as-is — Qoder's direct API
   *    frequently serves model ids we have never enumerated, and we'd rather let the
   *    upstream reject an unknown id than silently hide a routable one. (The third
   *    clause thus dominates the second for unknown ids.)
   */
  protected accountHasModel(account: QoderAccountRuntime, model: string): boolean {
    if (modelRequiresCliAuth(model)) return Boolean(account.config.qoderCliHome?.trim())
    const models = account.state.modelIds || []
    return !models.length || models.includes(model) || !QODER_KNOWN_MODEL_IDS.includes(model)
  }
  protected redactSecrets(config: QoderAccountConfig): QoderAccountConfig {
    return {
      ...config,
      personalAccessToken: config.personalAccessToken ? '***' : undefined
    }
  }
  protected accountLabel(account: QoderAccountRuntime): string {
    return account.config.email || account.config.label || account.config.id
  }

  // --- reload: normalize cached model ids + keep only routable models ---

  async reload(accountFiles: QoderAccountConfig[]): Promise<void> {
    this.accounts = accountFiles.map((account) => {
      const state = this.lookupState(account.id) ?? this.defaultAccountState()
      const normalized = normalizeCachedModelIds(
        Array.isArray(state.modelIds) ? state.modelIds : []
      )
      const supported = supportedModelIdsForAccount(account)
      const routableCachedModels = normalized.modelIds.filter((model) =>
        isModelRoutableForAccount(account, model)
      )
      state.modelIds = routableCachedModels.length ? routableCachedModels : supported
      if (normalized.changed) state.modelsCachedAt = 0
      else state.modelsCachedAt ||= 0
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

  listAccounts(): QoderAccountRuntime[] {
    return this.accounts.map((runtime) => ({
      ...runtime,
      config: this.redactSecrets(runtime.config),
      state: {
        ...runtime.state,
        stats: { ...runtime.state.stats },
        modelIds: runtime.state.modelIds?.length
          ? [...runtime.state.modelIds]
          : supportedModelIdsForAccount(runtime.config)
      }
    }))
  }

  listModels(): string[] {
    const set = new Set<string>()
    for (const account of this.accounts) {
      if (account.config.enabled === false) continue
      const models = account.state.modelIds?.length
        ? account.state.modelIds
        : supportedModelIdsForAccount(account.config)
      for (const model of models) {
        if (isModelRoutableForAccount(account.config, model)) set.add(model)
      }
    }
    if (!set.size) return [...QODER_DIRECT_MODEL_IDS]
    return [...set].sort()
  }

  hasDirectAccounts(): boolean {
    return this.accounts.some(
      (account) => account.config.enabled !== false && qoderAccountUsesDirectApi(account.config)
    )
  }

  async listModelsFresh(): Promise<string[]> {
    await Promise.allSettled(
      this.accounts
        .filter((account) => account.config.enabled !== false)
        .map((account) => this.maybeRefreshModels(account))
    )
    return this.listModels()
  }

  // --- account selection: availability → direct-api → legacy → model ---

  getAccount(model: string, exclude = new Set<string>()): QoderAccountRuntime | undefined {
    const normalizedModel = this.normalizeModel(model)
    return this.pickAccountTwoPassSync(exclude, (account, relax) => {
      if (relax) {
        if (this.isHardOffline(account.state.status)) return false
      } else if (!this.isAvailable(account, Date.now())) {
        return false
      }
      if (!qoderAccountUsesDirectApi(account.config)) return false
      if (isQoderLegacyModel(normalizedModel) && !account.config.qoderCliHome?.trim()) return false
      return this.accountHasModel(account, normalizedModel)
    })
  }

  async testAccount(accountId: string): Promise<AccountTestResult> {
    const account = this.accounts.find((a) => a.config.id === accountId)
    if (!account) return { ok: false, accountId, message: 'Account not found' }
    try {
      if (!qoderAccountUsesDirectApi(account.config)) {
        throw new Error(
          'Qoder direct API requires a Personal Access Token or an imported qodercli auth bundle.'
        )
      }
      await this.runSmokeTest(account)
      const models = await this.refreshAccountModels(account)
      this.transitionStatus(account, 'available', undefined)
      account.state.lastError = undefined
      this.onStateChanged()
      return {
        ok: true,
        accountId,
        message: 'Qoder direct API account is valid',
        models,
        authType: qoderAuthType(account.config)
      }
    } catch (error) {
      const message = toErrorMessage(error)
      account.state.failures += 1
      account.state.lastFailureAt = Date.now()
      account.state.lastError = message
      const classified = classifyQoderError(error)
      this.transitionStatus(
        account,
        classified.kind === 'auth' ? 'auth_failed' : 'cooling',
        message.slice(0, 200),
        Date.now() + classified.cooldownMs
      )
      this.onStateChanged()
      return { ok: false, accountId, message }
    }
  }

  async getAccountInfo(accountId: string): Promise<any> {
    const account = this.accounts.find((a) => a.config.id === accountId)
    if (!account) throw new Error('Account not found')
    await this.maybeRefreshModels(account)
    const models = account.state.modelIds?.length ? account.state.modelIds : QODER_KNOWN_MODEL_IDS
    let profile: Awaited<ReturnType<typeof fetchQoderAccountProfile>> | undefined
    let profileError: string | undefined
    try {
      profile = await fetchQoderAccountProfile(account.config, this.config.settings)
    } catch (error) {
      profileError = toErrorMessage(error)
      this.logger.warn(`Qoder account profile refresh failed: ${profileError}`, {
        provider: 'qoder',
        accountId: this.accountLabel(account),
        category: 'account'
      })
    }
    return {
      subscription: profile?.subscription ?? {
        title: 'Qoder',
        type: qoderAuthType(account.config)
      },
      email: profile?.email ?? account.config.email,
      usage: profile?.usage,
      keyInfo: {
        apiBaseUrl: this.config.settings.apiBaseUrl,
        authType: qoderAuthType(account.config),
        modelsCachedAt: account.state.modelsCachedAt,
        directApi: qoderAccountUsesDirectApi(account.config),
        ...(profile?.keyInfo ?? {}),
        ...(profileError ? { profileError } : {})
      },
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
    account.state.modelsCachedAt = 0
    const models = await this.refreshAccountModels(account)
    return { models }
  }

  // --- failure reporting: qoder applies exponential backoff (cap 16×) only to
  // server_error / network; every other kind uses a flat cooldownMs. Override
  // only resolveCooldown; the counter/log preamble comes from BaseAccountPool. ---

  protected resolveCooldown(
    account: QoderAccountRuntime,
    classified: QoderClassifiedError,
    now: number
  ): { status: AccountStatus; cooldownUntil?: number } {
    const statusMap: Record<string, AccountStatus> = {
      auth: 'auth_failed',
      rate_limit: 'rate_limited',
      quota: 'quota_exceeded'
    }
    const status = statusMap[classified.kind] || 'cooling'
    const multiplier =
      classified.kind === 'server_error' || classified.kind === 'network'
        ? Math.min(16, Math.pow(2, Math.max(0, account.state.failures - 1)))
        : 1
    return { status, cooldownUntil: now + classified.cooldownMs * multiplier }
  }

  async resetAccount(accountId: string): Promise<void> {
    const account = this.accounts.find((a) => a.config.id === accountId)
    if (!account) throw new Error('Account not found')
    account.state.failures = 0
    account.state.lastError = undefined
    account.state.lastFailureAt = 0
    account.state.lastResponseKind = undefined
    account.state.cooldownUntil = undefined
    this.transitionStatus(account, 'available', undefined)
    this.onStateChanged()
  }

  // --- sync two-pass loop: qoder's getAccount is synchronous, so it uses the
  // shared BaseAccountPool.pickAccountTwoPassSync helper instead of the async
  // generic. ---

  private async runSmokeTest(account: QoderAccountRuntime): Promise<void> {
    let text = ''
    for await (const event of streamQoderChatCompletion({
      account: account.config,
      settings: this.config.settings,
      body: {
        model: 'auto',
        stream: true,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Reply with OK only.' }]
      },
      model: 'auto',
      context: {
        requestId: `qoder-test-${account.config.id}`,
        apiFormat: 'openai',
        abortSignal: AbortSignal.timeout(60_000)
      }
    })) {
      if (event.text) text += event.text
    }
    if (!text.trim()) throw new Error('Qoder direct API completed without assistant output')
  }

  private async maybeRefreshModels(account: QoderAccountRuntime): Promise<void> {
    const now = Date.now()
    if (account.state.modelsCachedAt && now - account.state.modelsCachedAt < MODELS_CACHE_TTL_MS)
      return
    try {
      await this.refreshAccountModels(account)
    } catch (error) {
      this.logger.warn(`Qoder model refresh failed: ${toErrorMessage(error)}`, {
        provider: 'qoder',
        accountId: this.accountLabel(account),
        category: 'account'
      })
    }
  }

  private async refreshAccountModels(account: QoderAccountRuntime): Promise<string[]> {
    let models: string[]
    try {
      models = qoderAccountUsesDirectApi(account.config)
        ? await listQoderDirectModels(account.config, this.config.settings)
        : [...QODER_KNOWN_MODEL_IDS]
    } catch {
      models = account.state.modelIds?.length ? account.state.modelIds : [...QODER_KNOWN_MODEL_IDS]
    }
    account.state.modelIds = models.length ? models : [...QODER_KNOWN_MODEL_IDS]
    account.state.modelsCachedAt = Date.now()
    this.onStateChanged()
    return account.state.modelIds
  }
}

export function classifyQoderError(error: unknown): QoderClassifiedError {
  const msg = toErrorMessage(error).toLowerCase()
  if (
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('invalid token') ||
    msg.includes('personal access token') ||
    msg.includes('authentication')
  ) {
    return { kind: 'auth', cooldownMs: 0 }
  }
  if (msg.includes('quota') || msg.includes('credit') || msg.includes('insufficient')) {
    return { kind: 'quota', cooldownMs: 10 * 60_000 }
  }
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many')) {
    return { kind: 'rate_limit', cooldownMs: 60_000 }
  }
  if (msg.includes('timeout') || msg.includes('timed out')) {
    return { kind: 'timeout', cooldownMs: 5_000 }
  }
  if (
    msg.includes('enoent') ||
    msg.includes('not found') ||
    msg.includes('econn') ||
    msg.includes('enotfound') ||
    msg.includes('network')
  ) {
    return { kind: 'network', cooldownMs: 15_000 }
  }
  return { kind: 'server_error', cooldownMs: 15_000 }
}

function normalizeCachedModelIds(modelIds: string[]): { modelIds: string[]; changed: boolean } {
  const normalized: string[] = []
  let changed = false
  for (const modelId of modelIds) {
    const model = normalizeQoderModel(modelId)
    if (model !== modelId) changed = true
    if (!normalized.includes(model)) normalized.push(model)
  }
  if (normalized.length !== modelIds.length) changed = true
  return { modelIds: normalized, changed }
}

function supportedModelIdsForAccount(account: QoderAccountConfig): string[] {
  return account.qoderCliHome?.trim() ? [...QODER_KNOWN_MODEL_IDS] : [...QODER_DIRECT_MODEL_IDS]
}

function isModelRoutableForAccount(account: QoderAccountConfig, model: string): boolean {
  return !modelRequiresCliAuth(model) || Boolean(account.qoderCliHome?.trim())
}

function modelRequiresCliAuth(model: string): boolean {
  return isQoderLegacyModel(normalizeQoderModel(model))
}

function qoderAuthType(
  config: QoderAccountConfig
): 'qoder-personal-access-token' | 'qoder-cli-auth' {
  if (config.personalAccessToken) return 'qoder-personal-access-token'
  return 'qoder-cli-auth'
}

// re-exported type aliases used by consumers
export type { AccountStatus, ResponseKind }
