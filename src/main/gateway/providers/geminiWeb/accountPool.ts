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
import {
  clearProxyAgentCache,
  fetchAccessToken,
  fetchModels,
  patchSidts,
  rotateSidts
} from './http'
import type { GeminiWebRequestContext } from './types'

export type GeminiWebAccountRuntime = AccountWithState<GeminiWebAccountConfig>

export interface GeminiWebClassifiedError extends ClassifiedError {}

const MODELS_CACHE_TTL_MS = 30 * 60_000
// SIDTS 寿命约 5~15 分钟。5 分钟轮换一次保证下次真实请求拿到的是新鲜 SIDTS,
// 不必先撞"session tokens not found"再续。纯后台心跳,不依赖请求触发。
const KEEPALIVE_INTERVAL_MS = 5 * 60_000

export class GeminiWebAccountPool extends BaseAccountPool<GeminiWebAccountConfig> {
  protected providerName = 'geminiWeb'

  private keepAliveTimer: ReturnType<typeof setInterval> | null = null

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
    // 先停旧定时器，防止 reload 中途抛异常时旧定时器还在跑（僵尸 tick 引用已释放的
    // this.accounts）。startKeepAlive 在 finally 里重建新定时器。
    this.stopKeepAlive()
    try {
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
      // 账号加载完即启动保活,避免 reload 重复挂表(rebuild 时旧 provider dispose
      // 已清掉定时器,这里重建是安全的)。
      this.startKeepAlive()
    } catch (e) {
      // reload 失败时不重启定时器，此时 this.accounts 可能处于中间状态。
      this.stopKeepAlive()
      throw e
    }
  }

  /**
   * 启动 SIDTS 后台保活:每 5 分钟对所有启用且未 auth_failed 的账号轮换一次 SIDTS,
   * 新值回写内存 + 磁盘(复用 persistAccount)。保活失败绝不打 auth_failed——
   * rotateSidts 返回 null 可能只是网络抖动或 SIDTS 还没到续期点,只有真实请求
   * 拿不到 SNlM0e 才判账号死。避免保活误伤好账号。
   */
  startKeepAlive(): void {
    this.stopKeepAlive()
    this.keepAliveTimer = setInterval(() => {
      void this.tickKeepAlive()
    }, KEEPALIVE_INTERVAL_MS)
    // setInterval 在 Node 里默认不阻止退出,但 unref 让它在 app 关闭时不卡进程。
    if (typeof this.keepAliveTimer.unref === 'function') {
      this.keepAliveTimer.unref()
    }
  }

  stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
  }

  override async dispose(): Promise<void> {
    this.stopKeepAlive()
    clearProxyAgentCache()
    await super.dispose()
  }

  private async tickKeepAlive(): Promise<void> {
    // 串行处理多账号,避免瞬时并发打 Google 触发风控。
    for (const account of this.accounts) {
      if (account.config.enabled === false) continue
      if (account.state.status === 'auth_failed') continue
      try {
        const ctx = this.buildRequestContext(account)
        const newSidts = await rotateSidts(ctx)
        if (!newSidts) {
          // 静默跳过:可能主会话已弱化或网络抖动,留给真实请求再判定。
          this.logger.info('geminiWeb keepalive: rotateSidts returned no new SIDTS, skipping', {
            accountId: account.config.email || account.config.id
          })
          continue
        }
        account.config.cookieHeader = patchSidts(account.config.cookieHeader, newSidts)
        if (this.persistAccount) {
          try {
            await this.persistAccount(account.config.id, {
              cookieHeader: account.config.cookieHeader
            })
          } catch (err) {
            // 持久化失败不影响内存里的新鲜 cookie,下次 tick 再尝试回写。
            this.logger.warn(`geminiWeb keepalive: persistAccount failed: ${toErrorMessage(err)}`, {
              accountId: account.config.email || account.config.id
            })
          }
        }
        this.logger.info('geminiWeb keepalive: rotated SIDTS', {
          accountId: account.config.email || account.config.id
        })
      } catch (err) {
        // 任何异常只 log,不抛、不影响下一次 tick 或其它账号。
        this.logger.warn(`geminiWeb keepalive: tick failed: ${toErrorMessage(err)}`, {
          accountId: account.config.email || account.config.id
        })
      }
    }
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
