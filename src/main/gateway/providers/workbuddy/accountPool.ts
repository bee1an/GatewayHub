import type {
  AccountRuntimeState,
  AccountStatus,
  AccountTestResult,
  ProviderCheckinResult,
  WorkBuddyAccountConfig,
  WorkBuddyProviderConfig,
  WorkBuddyProviderState
} from '../../types'
import { GatewayLogger } from '../../core/logger'
import { toErrorMessage } from '../../core/utils'
import {
  BaseAccountPool,
  type AccountWithState,
  type ClassifiedError
} from '../../core/accountPool'
import {
  WorkBuddyAuthError,
  WorkBuddyAuthManager,
  buildWorkBuddyHeaders,
  type WorkBuddyTokenSnapshot
} from './client'
import { claimCheckin, cnDayKey, getCheckinStatus, getCreditsUsage } from './checkin'
import { loadWorkBuddyProductModels } from './localState'
import {
  WORKBUDDY_CHAT_PATH,
  listWorkBuddyBuiltInModelIds,
  normalizeWorkBuddyModel
} from './constants'
import { joinUrl, workBuddyFetch } from './http'

export interface WorkBuddyAccountRuntime extends AccountWithState<WorkBuddyAccountConfig> {
  auth?: WorkBuddyAuthManager
}

export interface WorkBuddyClassifiedError extends ClassifiedError {}

const MODELS_CACHE_TTL_MS = 6 * 60 * 60_000

export class WorkBuddyAccountPool extends BaseAccountPool<WorkBuddyAccountConfig> {
  protected providerName = 'workbuddy'

  declare protected accounts: WorkBuddyAccountRuntime[]

  constructor(
    private readonly config: WorkBuddyProviderConfig,
    private readonly state: WorkBuddyProviderState,
    logger: GatewayLogger,
    onStateChanged: () => void,
    private readonly persistAccount?: (
      accountId: string,
      updates: Partial<WorkBuddyAccountConfig>
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
    return listWorkBuddyBuiltInModelIds()
  }
  protected normalizeModel(model: string): string {
    return normalizeWorkBuddyModel(model)
  }
  protected accountHasModel(_account: WorkBuddyAccountRuntime, _model: string): boolean {
    return true
  }
  protected redactSecrets(config: WorkBuddyAccountConfig): WorkBuddyAccountConfig {
    return {
      ...config,
      accessToken: config.accessToken ? '***' : undefined,
      refreshToken: config.refreshToken ? '***' : undefined
    }
  }
  protected accountLabel(account: WorkBuddyAccountRuntime): string {
    return (
      account.config.label || account.config.nickname || account.config.email || account.config.id
    )
  }

  async reload(accountFiles: WorkBuddyAccountConfig[]): Promise<void> {
    this.accounts = accountFiles.map((account) => {
      const state = this.lookupState(account.id) ?? this.defaultAccountState()
      state.modelsCachedAt = 0
      state.modelIds = []
      state.status ??= 'available'
      state.statusUpdatedAt ??= 0
      this.storeState(account.id, state)
      const runtime: WorkBuddyAccountRuntime = { config: account, state }
      this.ensureAuth(runtime)
      return runtime
    })
    const active = new Set(accountFiles.map((account) => account.id))
    for (const id of this.stateIds()) {
      if (!active.has(id)) this.deleteState(id)
    }
    this.onStateChanged()
  }

  listAccounts(): WorkBuddyAccountRuntime[] {
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
  ): Promise<WorkBuddyAccountRuntime | undefined> {
    const normalizedModel = normalizeWorkBuddyModel(model)
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
      const token = await auth.getAccessToken()
      await this.probeChat(account, token)
      await this.refreshAccountModels(account)
      this.transitionStatus(account, 'available')
      this.onStateChanged()
      return {
        ok: true,
        accountId,
        message: 'WorkBuddy account is valid',
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
    let checkinInfo: Record<string, unknown> | undefined
    try {
      const token = await this.ensureAuth(account).getAccessToken()
      // Real balance comes from resource-summary; check-in total_credits is a
      // separate activity wallet and only a fallback.
      creditsRemaining = await getCreditsUsage(account.config, token, this.config.settings)
      const status = await getCheckinStatus(account.config, token, this.config.settings)
      creditsRemaining ??= status.totalCredits
      checkinInfo = {
        checkedIn: status.checkedIn,
        active: status.active,
        streakDays: status.streakDays
      }
    } catch {
      // best-effort — the billing probe must not break account info display
    }
    return {
      id: account.config.id,
      subscription: { title: 'WorkBuddy', type: 'unknown' },
      nickname: account.config.nickname,
      uid: account.config.uid,
      domain: account.config.domain,
      creditsRemaining,
      checkin: checkinInfo,
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
    await this.refreshAccountModels(account)
    return { models: account.state.modelIds }
  }

  /**
   * Daily billing-meter check-in (checkin-status + daily-checkin, billing host
   * fallback inside checkin.ts). Same bookkeeping rules as TraeWork: failures
   * record lastError but never stamp lastDay, so the scheduler retries.
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
        const token = await this.ensureAuth(account).getAccessToken()
        const status = await getCheckinStatus(account.config, token, this.config.settings)
        if (!status.checkedIn && status.active) {
          await claimCheckin(account.config, token, this.config.settings)
        }
        const finalStatus = status.checkedIn
          ? status
          : await getCheckinStatus(account.config, token, this.config.settings)
        account.state.checkin = {
          lastDay: today,
          lastAt: Date.now(),
          lastCredits: finalStatus.totalCredits
        }
        if (!status.active) {
          result.skipped += 1
          result.results.push({
            accountId: id,
            ok: true,
            message: 'Check-in activity not active for this account'
          })
        } else {
          if (status.checkedIn) result.alreadyCheckedIn += 1
          else result.claimed += 1
          result.results.push({
            accountId: id,
            ok: true,
            checkedIn: finalStatus.checkedIn,
            credits: finalStatus.totalCredits
          })
        }
        this.logger.info('WorkBuddy check-in done', {
          provider: 'workbuddy',
          accountId: this.accountLabel(account),
          category: 'account',
          extra: {
            checkedIn: finalStatus.checkedIn,
            active: status.active,
            credits: finalStatus.totalCredits,
            streakDays: finalStatus.streakDays
          }
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
        this.logger.warn(`WorkBuddy check-in failed: ${message}`, {
          provider: 'workbuddy',
          accountId: this.accountLabel(account),
          category: 'account'
        })
      }
    }
    this.onStateChanged()
    return result
  }

  protected transitionStatus(
    account: WorkBuddyAccountRuntime,
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

  /** Cheap auth probe: a 1-token streaming chat request. */
  private async probeChat(account: WorkBuddyAccountRuntime, token: string): Promise<void> {
    const base = this.config.settings.backend
    const response = await workBuddyFetch(
      joinUrl(base, WORKBUDDY_CHAT_PATH),
      {
        method: 'POST',
        headers: buildWorkBuddyHeaders(account.config, token),
        body: JSON.stringify({
          model: 'auto',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
          stream: true
        }),
        signal: AbortSignal.timeout(20_000)
      },
      this.config.settings
    )
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new WorkBuddyAuthError(
        `WorkBuddy probe failed: HTTP ${response.status} ${text.slice(0, 300)}`,
        response.status,
        response.status === 401 || response.status === 403
      )
    }
    await response.body?.cancel().catch(() => undefined)
  }

  private async maybeRefreshAccountModels(account: WorkBuddyAccountRuntime): Promise<void> {
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

  private async refreshAccountModels(account: WorkBuddyAccountRuntime): Promise<void> {
    // The catalog is bundled in the desktop app's cli/product.json; there is no
    // server-side /v2/models endpoint.
    let models: string[] = []
    try {
      models = await loadWorkBuddyProductModels(this.config.settings.productJsonPath)
    } catch {
      // fall back to built-in list
    }
    account.state.modelIds = models.length ? models.sort() : this.seedModels()
    account.state.modelsCachedAt = Date.now()
    this.onStateChanged()
  }

  private ensureAuth(account: WorkBuddyAccountRuntime): WorkBuddyAuthManager {
    if (!account.auth) {
      account.auth = new WorkBuddyAuthManager(
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

  private async tryEnsureAuth(account: WorkBuddyAccountRuntime): Promise<boolean> {
    try {
      await this.ensureAuth(account).getAccessToken()
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

export function classifyWorkBuddyError(error: unknown): WorkBuddyClassifiedError {
  if (error instanceof WorkBuddyAuthError) return { kind: 'auth', cooldownMs: 0 }
  const raw = toErrorMessage(error)
  const msg = raw.toLowerCase()
  if (/unauthorized|unauthenticated|invalid token|missing token|\b401\b|\b403\b|auth/.test(msg))
    return { kind: 'auth', cooldownMs: 0 }
  if (/quota|usage limit|insufficient|balance|exceeded/.test(msg))
    return { kind: 'quota', cooldownMs: 60 * 60_000 }
  if (/rate limit|too many requests|\b429\b|busy|high demand/.test(msg))
    return { kind: 'rate_limit', cooldownMs: 60_000 }
  if (/timeout|idle timeout/.test(msg)) return { kind: 'timeout', cooldownMs: 30_000 }
  if (/fetch failed|econnrefused|econnreset|enotfound|network/.test(msg))
    return { kind: 'network', cooldownMs: 15_000 }
  return { kind: 'server_error', cooldownMs: 30_000 }
}

function applyTokenSnapshot(
  account: WorkBuddyAccountConfig,
  snapshot: WorkBuddyTokenSnapshot
): void {
  if (snapshot.accessToken) account.accessToken = snapshot.accessToken
  if (snapshot.refreshToken) account.refreshToken = snapshot.refreshToken
  if (snapshot.tokenExpiresAt) account.tokenExpiresAt = snapshot.tokenExpiresAt
  if (snapshot.refreshExpiresAt) account.refreshExpiresAt = snapshot.refreshExpiresAt
  if (snapshot.domain) account.domain = snapshot.domain
}
