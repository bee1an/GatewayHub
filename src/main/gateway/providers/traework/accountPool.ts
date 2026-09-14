import type {
  AccountRuntimeState,
  AccountStatus,
  AccountTestResult,
  ProviderCheckinResult,
  TraeWorkAccountConfig,
  TraeWorkProviderConfig,
  TraeWorkProviderState
} from '../../types'
import { GatewayLogger } from '../../core/logger'
import { toErrorMessage } from '../../core/utils'
import {
  BaseAccountPool,
  type AccountWithState,
  type ClassifiedError
} from '../../core/accountPool'
import { TraeWorkAuthError, TraeWorkAuthManager, type TraeWorkTokenSnapshot } from './client'
import { claimCheckin, cnDayKey, getCheckinStatus, getCreditsUsage } from './checkin'
import {
  DEFAULT_TRAEWORK_MODEL,
  describeTraeWorkModel,
  listTraeWorkBuiltInModelIds,
  normalizeTraeWorkModel
} from './constants'

export interface TraeWorkAccountRuntime extends AccountWithState<TraeWorkAccountConfig> {
  auth?: TraeWorkAuthManager
}

export interface TraeWorkClassifiedError extends ClassifiedError {}

const MODELS_CACHE_TTL_MS = 30 * 60_000

export class TraeWorkAccountPool extends BaseAccountPool<TraeWorkAccountConfig> {
  protected providerName = 'traework'

  declare protected accounts: TraeWorkAccountRuntime[]

  constructor(
    private readonly config: TraeWorkProviderConfig,
    private readonly state: TraeWorkProviderState,
    logger: GatewayLogger,
    onStateChanged: () => void,
    private readonly persistAccount?: (
      accountId: string,
      updates: Partial<TraeWorkAccountConfig>
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
    return listTraeWorkBuiltInModelIds()
  }
  protected normalizeModel(model: string): string {
    return normalizeTraeWorkModel(model)
  }
  protected accountHasModel(account: TraeWorkAccountRuntime, model: string): boolean {
    const list = account.state.modelIds || []
    if (!list.length) return true
    return list.some((available) => normalizeTraeWorkModel(available) === model)
  }
  protected redactSecrets(config: TraeWorkAccountConfig): TraeWorkAccountConfig {
    return {
      ...config,
      jwtToken: config.jwtToken ? '***' : undefined,
      refreshToken: config.refreshToken ? '***' : undefined
    }
  }
  protected accountLabel(account: TraeWorkAccountRuntime): string {
    return account.config.email || account.config.label || account.config.id
  }

  async reload(accountFiles: TraeWorkAccountConfig[]): Promise<void> {
    this.accounts = accountFiles.map((account) => {
      const state = this.lookupState(account.id) ?? this.defaultAccountState()
      state.modelsCachedAt = 0
      state.modelIds = []
      state.status ??= 'available'
      state.statusUpdatedAt ??= 0
      this.storeState(account.id, state)
      const runtime: TraeWorkAccountRuntime = { config: account, state }
      this.ensureAuth(runtime)
      return runtime
    })
    const active = new Set(accountFiles.map((account) => account.id))
    for (const id of this.stateIds()) {
      if (!active.has(id)) this.deleteState(id)
    }
    this.onStateChanged()
  }

  listAccounts(): TraeWorkAccountRuntime[] {
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
      const models = account.state.modelIds?.length ? account.state.modelIds : this.seedModels()
      for (const model of models) set.add(model)
    }
    if (!set.size && this.config.enabled) {
      for (const model of this.seedModels()) set.add(model)
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

  async getAccountForModel(
    model: string,
    exclude = new Set<string>()
  ): Promise<TraeWorkAccountRuntime | undefined> {
    const normalizedModel = normalizeTraeWorkModel(model || DEFAULT_TRAEWORK_MODEL)
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
      const updates: Partial<TraeWorkAccountConfig> = {}
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
        message: 'TraeWork account is valid',
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
    let creditsRemaining: number | undefined
    try {
      const token = await this.ensureAuth(account).getJwtToken()
      creditsRemaining = await getCreditsUsage(account.config, token, this.config.settings)
    } catch {
      // best-effort — entitlement lookup must not break account info display
    }
    return {
      id: account.config.id,
      subscription: { title: 'TraeWork', type: 'unknown' },
      email: account.config.email,
      countryCode: account.config.countryCode,
      creditsRemaining,
      endpoints: {
        authBaseUrl: account.config.authBaseUrl || this.config.settings.authBaseUrl,
        coreBaseUrl: account.config.coreBaseUrl || this.config.settings.coreBaseUrl
      },
      models: (account.state.modelIds || []).map((model) => {
        const detail = describeTraeWorkModel(model)
        return {
          modelId: model,
          modelName: detail?.displayName || model,
          rateMultiplier: 1,
          rateUnit: 'request',
          capabilities: detail?.capabilities
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

  /**
   * Daily Trae CN check-in (checkin_credits/status + claim). Accounts already
   * confirmed for the current CN day are skipped unless `force`. Failures are
   * recorded on state.checkin.lastError but never flip the confirmed day, so
   * the scheduler can keep retrying until the daily claim lands.
   */
  async checkinAccounts(accountId?: string, force = false): Promise<ProviderCheckinResult> {
    const today = cnDayKey()
    const targets = accountId
      ? this.accounts.filter((item) => item.config.id === accountId)
      : this.accounts.filter((item) => item.config.enabled !== false)
    const result: ProviderCheckinResult = {
      ok: true,
      claimed: 0,
      alreadyCheckedIn: 0,
      skipped: 0,
      failed: 0,
      results: []
    }
    if (accountId && !targets.length) {
      result.ok = false
      result.results.push({ accountId, ok: false, message: 'Account not found' })
      return result
    }
    for (const account of targets) {
      const id = account.config.id
      const existing = account.state.checkin
      if (!force && existing?.lastDay === today) {
        result.skipped += 1
        result.results.push({
          accountId: id,
          ok: true,
          checkedIn: true,
          credits: existing.lastCredits
        })
        continue
      }
      try {
        const token = await this.ensureAuth(account).getJwtToken()
        let status = await getCheckinStatus(account.config, token, this.config.settings)
        let claimed = false
        if (!status.checkedIn && status.enable) {
          await claimCheckin(account.config, token, this.config.settings)
          claimed = true
          status = await getCheckinStatus(account.config, token, this.config.settings)
        }
        const totalCredits = status.credits + status.extraCredits
        account.state.checkin = {
          lastDay: today,
          lastAt: Date.now(),
          lastCredits: totalCredits
        }
        if (!status.enable) {
          result.skipped += 1
          result.results.push({
            accountId: id,
            ok: true,
            credits: totalCredits,
            message: 'Check-in not enabled for this account'
          })
        } else {
          if (claimed) result.claimed += 1
          else result.alreadyCheckedIn += 1
          result.results.push({
            accountId: id,
            ok: true,
            checkedIn: status.checkedIn,
            credits: totalCredits
          })
        }
        this.logger.info('TraeWork check-in done', {
          provider: 'traework',
          accountId: this.accountLabel(account),
          category: 'account',
          extra: { claimed, credits: totalCredits, enable: status.enable }
        })
      } catch (error) {
        const message = toErrorMessage(error)
        account.state.checkin = {
          ...(existing || {}),
          lastAt: Date.now(),
          lastError: message.slice(0, 300)
        }
        result.failed += 1
        result.ok = false
        result.results.push({ accountId: id, ok: false, message })
        this.logger.warn(`TraeWork check-in failed: ${message}`, {
          provider: 'traework',
          accountId: this.accountLabel(account),
          category: 'account'
        })
      }
    }
    this.onStateChanged()
    return result
  }

  protected transitionStatus(
    account: TraeWorkAccountRuntime,
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

  private async maybeRefreshAccountModels(account: TraeWorkAccountRuntime): Promise<void> {
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

  private async refreshAccountModels(account: TraeWorkAccountRuntime): Promise<void> {
    let models: string[] = []
    try {
      models = await this.ensureAuth(account).getModelList()
    } catch (error) {
      this.logger.warn(`TraeWork model list refresh failed: ${toErrorMessage(error)}`, {
        provider: 'traework',
        accountId: this.accountLabel(account),
        category: 'account'
      })
    }
    const usableModels = sanitizeUsableModelIds(models)
    account.state.modelIds = usableModels.length ? usableModels : this.seedModels()
    account.state.modelsCachedAt = Date.now()
    this.onStateChanged()
  }

  private ensureAuth(account: TraeWorkAccountRuntime): TraeWorkAuthManager {
    if (!account.auth) {
      account.auth = new TraeWorkAuthManager(
        account.config,
        this.config.settings,
        async (snapshot) => {
          applyTokenSnapshot(account.config, snapshot)
          await this.persistAccount?.(account.config.id, snapshot)
        }
      )
      account.auth.initialize()
    }
    return account.auth
  }

  private async tryEnsureAuth(account: TraeWorkAccountRuntime): Promise<boolean> {
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
}

export function classifyTraeWorkError(error: unknown): TraeWorkClassifiedError {
  if (error instanceof TraeWorkAuthError) return { kind: 'auth', cooldownMs: 0 }
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
    set.add(normalizeTraeWorkModel(trimmed))
  }
  return [...set].sort()
}

function applyTokenSnapshot(account: TraeWorkAccountConfig, snapshot: TraeWorkTokenSnapshot): void {
  if (snapshot.jwtToken) account.jwtToken = snapshot.jwtToken
  if (snapshot.refreshToken) account.refreshToken = snapshot.refreshToken
  if (snapshot.tokenExpiresAt) account.tokenExpiresAt = snapshot.tokenExpiresAt
  if (snapshot.refreshExpiresAt) account.refreshExpiresAt = snapshot.refreshExpiresAt
}
