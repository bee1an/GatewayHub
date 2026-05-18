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
import { FALLBACK_MODELS } from './constants'
import { KiroAuthManager } from './auth'

export interface KiroAccountRuntime {
  config: KiroAccountConfig
  state: AccountRuntimeState
  auth?: KiroAuthManager
}

export class KiroAccountPool {
  private accounts: KiroAccountRuntime[] = []
  private currentAccountIndex = 0

  constructor(
    private readonly config: KiroProviderConfig,
    private readonly state: KiroProviderState,
    private readonly logger: GatewayLogger,
    private readonly onStateChanged: () => void
  ) {
    this.currentAccountIndex = state.currentAccountIndex || 0
  }

  async reload(accountFiles: KiroAccountConfig[]): Promise<void> {
    this.accounts = accountFiles.map((account) => {
      const state = this.state.accounts[account.id] ?? defaultAccountState()
      state.modelIds = state.modelIds?.length ? state.modelIds : [...FALLBACK_MODELS]
      // 兼容旧状态文件：补默认值
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

  listAccounts(): Array<KiroAccountRuntime & { safeConfig: KiroAccountConfig }> {
    return this.accounts.map((runtime) => ({
      ...runtime,
      safeConfig: redactAccount(runtime.config)
    }))
  }

  listModels(): string[] {
    const set = new Set<string>()
    for (const account of this.accounts) {
      if (account.config.enabled === false) continue
      for (const model of account.state.modelIds?.length ? account.state.modelIds : FALLBACK_MODELS)
        set.add(model)
    }
    if (!set.size) for (const model of FALLBACK_MODELS) set.add(model)
    return [...set].sort()
  }

  async getAccountForModel(
    model: string,
    exclude = new Set<string>()
  ): Promise<KiroAccountRuntime | undefined> {
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

    // 第二轮降级：忽略 cooldown 概率试探，但仍跳过硬下线状态
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

  async reportSuccess(account: KiroAccountRuntime): Promise<void> {
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
    account: KiroAccountRuntime,
    error: unknown,
    classified: ClassifiedKiroError
  ): Promise<void> {
    account.state.failures += 1
    account.state.lastFailureAt = Date.now()
    account.state.lastError = toErrorMessage(error)
    account.state.stats.totalRequests += 1
    account.state.stats.failedRequests += 1
    account.state.lastResponseKind = classified.kind

    const reason = account.state.lastError?.slice(0, 200)
    let nextStatus: AccountStatus
    let cooldownUntil: number | undefined
    const now = Date.now()
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
      case 'server_error':
      case 'timeout':
      case 'network':
      default: {
        nextStatus = 'cooling'
        const base = Math.max(1000, classified.cooldownMs)
        const multiplier = Math.min(
          this.config.settings.accountMaxBackoffMultiplier,
          Math.pow(2, Math.max(0, account.state.failures - 1))
        )
        cooldownUntil = now + base * multiplier
        break
      }
    }
    this.transitionStatus(account, nextStatus, reason, cooldownUntil)
    this.logger.warn(account.state.lastError ?? 'Kiro request failed', {
      provider: 'kiro',
      accountId: account.config.id
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
    this.logger.info(`Account status set to ${status}${reason ? `: ${reason}` : ''}`, {
      provider: 'kiro',
      accountId
    })
    this.onStateChanged()
  }

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
      this.modelsCache.set(accountId, { data: result, cachedAt: Date.now() })
      return result
    } catch (error) {
      const fallback = this.fallbackModelsResponse()
      if (!cached) this.modelsCache.set(accountId, { data: fallback, cachedAt: Date.now() })
      this.logger.warn(`listAvailableModels failed for ${accountId}: ${toErrorMessage(error)}`, {
        provider: 'kiro',
        accountId
      })
      return cached?.data || fallback
    }
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
        accountId
      })
    if (modelsResult.status === 'fulfilled') models = modelsResult.value
    else
      this.logger.warn(
        `listAvailableModels failed for ${accountId}: ${modelsResult.reason?.message}`,
        { provider: 'kiro', accountId }
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
      accountId: account.config.id
    })
  }

  private recordAccountError(account: KiroAccountRuntime, error: unknown): void {
    account.state.failures += 1
    account.state.lastFailureAt = Date.now()
    account.state.lastError = toErrorMessage(error)
    account.state.lastResponseKind = 'auth'
    this.transitionStatus(account, 'auth_failed', account.state.lastError?.slice(0, 200))
    this.logger.warn(account.state.lastError, { provider: 'kiro', accountId: account.config.id })
    this.onStateChanged()
  }

  private transitionStatus(
    account: KiroAccountRuntime,
    status: AccountStatus,
    reason?: string,
    cooldownUntil?: number
  ): void {
    account.state.status = status
    account.state.statusReason = reason
    account.state.statusUpdatedAt = Date.now()
    account.state.cooldownUntil = cooldownUntil
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

  private isAvailable(account: KiroAccountRuntime, now: number): boolean {
    const status = account.state.status
    if (status === 'available') return true
    if (isHardOffline(status)) return false
    // cooling / rate_limited：到期视为可用
    if (account.state.cooldownUntil && now > account.state.cooldownUntil) return true
    return Math.random() < this.config.settings.probabilisticRetryChance
  }

  private accountHasModel(account: KiroAccountRuntime, model: string): boolean {
    const models = account.state.modelIds?.length ? account.state.modelIds : FALLBACK_MODELS
    return models.includes(model) || models.includes('auto-kiro') || models.includes('auto')
  }
}

export function toKiroModelId(model: string): string {
  if (model === 'auto-kiro') return 'auto'
  return model
    .replace(/claude-sonnet-4-5/g, 'claude-sonnet-4.5')
    .replace(/claude-haiku-4-5/g, 'claude-haiku-4.5')
}

function defaultAccountState(): AccountRuntimeState {
  return {
    failures: 0,
    lastFailureAt: 0,
    lastSuccessAt: 0,
    modelsCachedAt: 0,
    modelIds: [...FALLBACK_MODELS],
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

function redactAccount(account: KiroAccountConfig): KiroAccountConfig {
  return {
    ...account,
    refreshToken: account.refreshToken ? '***' : undefined,
    accessToken: account.accessToken ? '***' : undefined
  }
}
