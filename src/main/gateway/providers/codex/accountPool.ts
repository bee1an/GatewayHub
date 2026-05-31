import type {
  AccountRuntimeState,
  AccountStatus,
  AccountTestResult,
  CodexAccountConfig,
  CodexProviderConfig,
  CodexProviderState,
  ResponseKind
} from '../../types'
import { GatewayLogger } from '../../core/logger'
import { toErrorMessage } from '../../core/utils'
import { CodexAuthManager, type CodexAccountSnapshot } from './auth'
import { FALLBACK_CODEX_MODELS, normalizeCodexModel } from './constants'
import { fetchCodexModels } from './models'
import { summarizeAccount } from './normalize'
import { fetchCodexRateLimits } from './rateLimits'
import type { CodexAccountInfo } from './types'

export interface CodexAccountRuntime {
  config: CodexAccountConfig
  state: AccountRuntimeState
  auth?: CodexAuthManager
}

export interface CodexClassifiedError {
  kind: ResponseKind
  cooldownMs: number
  resetAtIso?: string
}

/** 模型列表缓存有效期：30 分钟 */
const MODELS_CACHE_TTL_MS = 30 * 60_000
/** 模型列表刷新失败后的退避时间：5 分钟（避免无限重试刷屏） */
const MODELS_REFRESH_BACKOFF_MS = 5 * 60_000

export class CodexAccountPool {
  private accounts: CodexAccountRuntime[] = []
  private currentAccountIndex = 0
  /** 防止同一账号并发刷新模型列表 */
  private modelRefreshInFlight = new Map<string, Promise<void>>()
  /** 模型刷新失败的时间戳：accountId → ms；用于退避避免高频重试 */
  private modelRefreshFailedAt = new Map<string, number>()

  constructor(
    private readonly config: CodexProviderConfig,
    private readonly state: CodexProviderState,
    private readonly logger: GatewayLogger,
    private readonly onStateChanged: () => void,
    private readonly persistAccount?: (
      accountId: string,
      updates: Partial<CodexAccountConfig>
    ) => Promise<void>
  ) {
    this.currentAccountIndex = state.currentAccountIndex || 0
  }

  private accountLabel(account: CodexAccountRuntime): string {
    return account.config.email || account.config.label || account.config.id
  }

  async reload(accountFiles: CodexAccountConfig[]): Promise<void> {
    this.accounts = accountFiles.map((account) => {
      const state = this.state.accounts[account.id] ?? defaultAccountState()
      // 没有缓存模型时先用 fallback 占位，等首次 refresh 拿到真实列表后覆盖
      if (!state.modelIds?.length) state.modelIds = [...FALLBACK_CODEX_MODELS]
      state.status ??= 'available'
      state.statusUpdatedAt ??= 0
      this.state.accounts[account.id] = state
      return { config: account, state }
    })
    const activeIds = new Set(accountFiles.map((a) => a.id))
    for (const id of Object.keys(this.state.accounts)) {
      if (!activeIds.has(id)) delete this.state.accounts[id]
    }
    this.onStateChanged()
  }

  listAccounts(): CodexAccountRuntime[] {
    return this.accounts.map((runtime) => ({
      ...runtime,
      config: redactAccount(runtime.config)
    }))
  }

  listModels(): string[] {
    // 懒加载：从所有启用账号触发后台刷新；返回值不等待 fetch，避免拖慢 status 调用
    void this.maybeRefreshModelsForAll()
    const set = new Set<string>()
    for (const account of this.accounts) {
      if (account.config.enabled === false) continue
      for (const model of account.state.modelIds || FALLBACK_CODEX_MODELS) set.add(model)
    }
    if (!set.size) for (const model of FALLBACK_CODEX_MODELS) set.add(model)
    return [...set].sort()
  }

  /** 对所有启用账号触发模型刷新（命中 TTL 时跳过；并发去重） */
  private async maybeRefreshModelsForAll(): Promise<void> {
    await Promise.all(
      this.accounts
        .filter((a) => a.config.enabled !== false)
        .map((a) => this.refreshAccountModels(a))
    )
  }

  /** 单账号模型刷新：命中 TTL 或失败退避直接返回；失败保留旧缓存 */
  private async refreshAccountModels(account: CodexAccountRuntime): Promise<void> {
    const now = Date.now()
    if (
      account.state.modelsCachedAt &&
      now - account.state.modelsCachedAt < MODELS_CACHE_TTL_MS &&
      account.state.modelIds?.length
    ) {
      return
    }
    const lastFailed = this.modelRefreshFailedAt.get(account.config.id)
    if (lastFailed && now - lastFailed < MODELS_REFRESH_BACKOFF_MS) {
      return
    }
    const inflight = this.modelRefreshInFlight.get(account.config.id)
    if (inflight) return inflight
    const job = (async () => {
      try {
        if (!(await this.tryEnsureInitialized(account))) {
          this.modelRefreshFailedAt.set(account.config.id, Date.now())
          return
        }
        const models = await fetchCodexModels(account.auth!, this.config.settings)
        if (models.length) {
          account.state.modelIds = models
          account.state.modelsCachedAt = Date.now()
          this.modelRefreshFailedAt.delete(account.config.id)
          this.onStateChanged()
        }
      } catch (error) {
        this.modelRefreshFailedAt.set(account.config.id, Date.now())
        this.logger.warn(`Failed to fetch Codex models: ${toErrorMessage(error)}`, {
          provider: 'codex',
          accountId: this.accountLabel(account),
          category: 'account'
        })
      } finally {
        this.modelRefreshInFlight.delete(account.config.id)
      }
    })()
    this.modelRefreshInFlight.set(account.config.id, job)
    return job
  }

  async getAccountForModel(
    model: string,
    exclude = new Set<string>()
  ): Promise<CodexAccountRuntime | undefined> {
    if (!this.accounts.length) return undefined
    const now = Date.now()
    const start = this.currentAccountIndex % this.accounts.length

    for (let i = 0; i < this.accounts.length; i++) {
      const index = (start + i) % this.accounts.length
      const account = this.accounts[index]
      if (account.config.enabled === false || exclude.has(account.config.id)) continue
      if (!this.accountHasModel(account, model)) continue
      if (!this.isAvailable(account, now)) continue
      if (!(await this.tryEnsureInitialized(account))) continue
      this.currentAccountIndex = index
      this.state.currentAccountIndex = index
      this.onStateChanged()
      return account
    }
    // 第二轮：忽略 cooldown，但跳过 hard offline
    for (let i = 0; i < this.accounts.length; i++) {
      const index = (start + i) % this.accounts.length
      const account = this.accounts[index]
      if (account.config.enabled === false || exclude.has(account.config.id)) continue
      if (isHardOffline(account.state.status)) continue
      if (!this.accountHasModel(account, model)) continue
      if (!(await this.tryEnsureInitialized(account))) continue
      this.currentAccountIndex = index
      this.state.currentAccountIndex = index
      this.onStateChanged()
      return account
    }
    return undefined
  }

  async testAccount(accountId: string): Promise<AccountTestResult> {
    const account = this.accounts.find((item) => item.config.id === accountId)
    if (!account) return { ok: false, accountId, message: 'Account not found' }
    try {
      await this.ensureInitialized(account, true)
      const token = await account.auth!.getAccessToken()
      // 主动测试时强制刷新模型缓存，并清除上次失败退避
      account.state.modelsCachedAt = 0
      this.modelRefreshFailedAt.delete(account.config.id)
      await this.refreshAccountModels(account)
      return {
        ok: Boolean(token),
        accountId,
        message: 'Codex account is valid',
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

  async getAccountInfo(accountId: string): Promise<CodexAccountInfo> {
    const account = this.accounts.find((item) => item.config.id === accountId)
    if (!account) throw new Error('Account not found')
    await this.ensureInitialized(account)
    const base = summarizeAccount(account.config)
    try {
      const rateLimits = await fetchCodexRateLimits(account.auth!, this.config.settings)
      return { ...base, rateLimits }
    } catch (error) {
      this.logger.warn(`Failed to fetch Codex rate limits: ${toErrorMessage(error)}`, {
        provider: 'codex',
        accountId: this.accountLabel(account),
        category: 'account'
      })
      return base
    }
  }

  async reportSuccess(account: CodexAccountRuntime): Promise<void> {
    account.state.failures = 0
    account.state.lastError = undefined
    account.state.lastSuccessAt = Date.now()
    account.state.stats.totalRequests += 1
    account.state.stats.successfulRequests += 1
    account.state.lastResponseKind = 'success'
    this.transitionStatus(account, 'available', undefined)
    this.onStateChanged()
  }

  async reportFailure(
    account: CodexAccountRuntime,
    error: unknown,
    classified: CodexClassifiedError
  ): Promise<void> {
    account.state.failures += 1
    account.state.lastFailureAt = Date.now()
    account.state.lastError = toErrorMessage(error)
    account.state.stats.totalRequests += 1
    account.state.stats.failedRequests += 1
    account.state.lastResponseKind = classified.kind

    const reason = account.state.lastError?.slice(0, 200)
    const now = Date.now()
    let nextStatus: AccountStatus
    let cooldownUntil: number | undefined
    switch (classified.kind) {
      case 'auth':
        nextStatus = 'auth_failed'
        cooldownUntil = undefined
        break
      case 'quota':
        nextStatus = 'quota_exceeded'
        cooldownUntil = classified.resetAtIso
          ? new Date(classified.resetAtIso).getTime()
          : now + classified.cooldownMs
        break
      case 'rate_limit':
        nextStatus = 'rate_limited'
        cooldownUntil = now + classified.cooldownMs
        break
      default: {
        nextStatus = 'cooling'
        const base = Math.max(1000, classified.cooldownMs || 30_000)
        const multiplier = Math.min(64, Math.pow(2, Math.max(0, account.state.failures - 1)))
        cooldownUntil = now + base * multiplier
      }
    }
    this.transitionStatus(account, nextStatus, reason, cooldownUntil)
    this.logger.warn(account.state.lastError ?? 'Codex request failed', {
      provider: 'codex',
      accountId: this.accountLabel(account),
      category: 'account'
    })
    this.onStateChanged()
  }

  async resetAccount(accountId: string): Promise<void> {
    const account = this.accounts.find((item) => item.config.id === accountId)
    if (!account) return
    account.state.failures = 0
    account.state.lastError = undefined
    account.state.lastFailureAt = 0
    account.state.lastResponseKind = undefined
    this.transitionStatus(account, 'available', undefined)
    this.onStateChanged()
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
    this.logger.info(`Codex account status set to ${status}${reason ? `: ${reason}` : ''}`, {
      provider: 'codex',
      accountId: this.accountLabel(account),
      category: 'account'
    })
    this.onStateChanged()
  }

  private async tryEnsureInitialized(
    account: CodexAccountRuntime,
    force = false
  ): Promise<boolean> {
    try {
      await this.ensureInitialized(account, force)
      return true
    } catch (error) {
      this.recordAccountError(account, error)
      return false
    }
  }

  private async ensureInitialized(account: CodexAccountRuntime, force = false): Promise<void> {
    if (account.auth && !force) return
    const auth = new CodexAuthManager(account.config, this.config.settings, async (snapshot) => {
      await this.applySnapshot(account, snapshot)
    })
    auth.initialize()
    account.auth = auth
    if (!account.state.modelIds?.length) {
      account.state.modelIds = [...FALLBACK_CODEX_MODELS]
      // 注意：不要在这里设置 modelsCachedAt，否则会让 TTL 误判为「已新鲜」而跳过首次刷新
    }
    this.logger.info(`Initialized Codex account (${auth.authType})`, {
      provider: 'codex',
      accountId: this.accountLabel(account),
      category: 'account'
    })
  }

  /** auth refresh 后回写文件 + 内存 */
  private async applySnapshot(
    account: CodexAccountRuntime,
    snapshot: CodexAccountSnapshot
  ): Promise<void> {
    Object.assign(account.config, {
      accessToken: snapshot.accessToken || account.config.accessToken,
      refreshToken: snapshot.refreshToken || account.config.refreshToken,
      idToken: snapshot.idToken || account.config.idToken,
      gptWebAccountId: snapshot.gptWebAccountId || account.config.gptWebAccountId,
      expiresAt: snapshot.expiresAt ?? account.config.expiresAt,
      lastRefresh: snapshot.lastRefresh ?? account.config.lastRefresh,
      subscriptionActiveUntil:
        snapshot.subscriptionActiveUntil ?? account.config.subscriptionActiveUntil,
      email: snapshot.email ?? account.config.email,
      name: snapshot.name ?? account.config.name
    })
    if (this.persistAccount) {
      try {
        await this.persistAccount(account.config.id, {
          accessToken: account.config.accessToken,
          refreshToken: account.config.refreshToken,
          idToken: account.config.idToken,
          gptWebAccountId: account.config.gptWebAccountId,
          expiresAt: account.config.expiresAt,
          lastRefresh: account.config.lastRefresh,
          subscriptionActiveUntil: account.config.subscriptionActiveUntil,
          email: account.config.email,
          name: account.config.name
        })
      } catch (error) {
        this.logger.warn(`Failed to persist Codex tokens: ${toErrorMessage(error)}`, {
          provider: 'codex',
          accountId: this.accountLabel(account),
          category: 'account'
        })
      }
    }
  }

  private recordAccountError(account: CodexAccountRuntime, error: unknown): void {
    account.state.failures += 1
    account.state.lastFailureAt = Date.now()
    account.state.lastError = toErrorMessage(error)
    account.state.lastResponseKind = 'auth'
    this.transitionStatus(account, 'auth_failed', account.state.lastError?.slice(0, 200))
    this.logger.warn(account.state.lastError, {
      provider: 'codex',
      accountId: this.accountLabel(account),
      category: 'account'
    })
    this.onStateChanged()
  }

  private transitionStatus(
    account: CodexAccountRuntime,
    status: AccountStatus,
    reason?: string,
    cooldownUntil?: number
  ): void {
    account.state.status = status
    account.state.statusReason = reason
    account.state.statusUpdatedAt = Date.now()
    account.state.cooldownUntil = cooldownUntil
  }

  private isAvailable(account: CodexAccountRuntime, now: number): boolean {
    const status = account.state.status
    if (status === 'available') return true
    if (isHardOffline(status)) return false
    if (account.state.cooldownUntil && now > account.state.cooldownUntil) return true
    return Math.random() < 0.1
  }

  private accountHasModel(account: CodexAccountRuntime, model: string): boolean {
    const normalized = normalizeCodexModel(model)
    const list = account.state.modelIds?.length ? account.state.modelIds : FALLBACK_CODEX_MODELS
    return list.some((available) => normalizeCodexModel(available) === normalized)
  }
}

function defaultAccountState(): AccountRuntimeState {
  return {
    failures: 0,
    lastFailureAt: 0,
    lastSuccessAt: 0,
    modelsCachedAt: 0,
    modelIds: [...FALLBACK_CODEX_MODELS],
    status: 'available',
    statusUpdatedAt: 0,
    stats: {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0
    }
  }
}

function isHardOffline(status: AccountStatus): boolean {
  return status === 'auth_failed' || status === 'manual_disabled' || status === 'quota_exceeded'
}

function redactAccount(account: CodexAccountConfig): CodexAccountConfig {
  return {
    ...account,
    refreshToken: account.refreshToken ? '***' : undefined,
    accessToken: account.accessToken ? '***' : undefined,
    idToken: account.idToken ? '***' : undefined
  }
}
