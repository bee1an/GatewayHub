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
import { summarizeAccount } from './normalize'
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

export class CodexAccountPool {
  private accounts: CodexAccountRuntime[] = []
  private currentAccountIndex = 0

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
      state.modelIds = state.modelIds?.length ? state.modelIds : [...FALLBACK_CODEX_MODELS]
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
    const set = new Set<string>()
    for (const account of this.accounts) {
      if (account.config.enabled === false) continue
      for (const model of account.state.modelIds || FALLBACK_CODEX_MODELS) set.add(model)
    }
    if (!set.size) for (const model of FALLBACK_CODEX_MODELS) set.add(model)
    return [...set].sort()
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
    return summarizeAccount(account.config)
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
      account.state.modelsCachedAt = Date.now()
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
      chatgptAccountId: snapshot.chatgptAccountId || account.config.chatgptAccountId,
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
          chatgptAccountId: account.config.chatgptAccountId,
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
