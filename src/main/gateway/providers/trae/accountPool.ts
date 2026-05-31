import type {
  AccountRuntimeState,
  AccountStatus,
  AccountTestResult,
  ResponseKind,
  TraeAccountConfig,
  TraeProviderConfig,
  TraeProviderState
} from '../../types'
import { GatewayLogger } from '../../core/logger'
import { toErrorMessage } from '../../core/utils'
import { TraeAuthError, TraeAuthManager, type TraeTokenSnapshot } from './client'
import {
  DEFAULT_TRAE_MODEL,
  TRAE_BUILT_IN_MODELS,
  describeTraeModel,
  listTraeBuiltInModelIds,
  normalizeTraeModel
} from './constants'

export interface TraeAccountRuntime {
  config: TraeAccountConfig
  state: AccountRuntimeState
  auth?: TraeAuthManager
}

export interface TraeClassifiedError {
  kind: ResponseKind
  cooldownMs: number
}

const MODELS_CACHE_TTL_MS = 30 * 60_000

export class TraeAccountPool {
  private accounts: TraeAccountRuntime[] = []
  private currentAccountIndex = 0

  constructor(
    private readonly config: TraeProviderConfig,
    private readonly state: TraeProviderState,
    private readonly logger: GatewayLogger,
    private readonly onStateChanged: () => void,
    private readonly persistAccount?: (
      accountId: string,
      updates: Partial<TraeAccountConfig>
    ) => Promise<void>
  ) {
    this.currentAccountIndex = state.currentAccountIndex || 0
  }

  async reload(accountFiles: TraeAccountConfig[]): Promise<void> {
    this.accounts = accountFiles.map((account) => {
      const fallbackModels = this.modelsForAccount(account)
      const state = this.state.accounts[account.id] ?? defaultAccountState(fallbackModels)
      state.modelIds = sanitizeUsableModelIds(
        state.modelIds?.length ? state.modelIds : fallbackModels
      )
      if (!state.modelIds.length) state.modelIds = fallbackModels
      state.status ??= 'available'
      state.statusUpdatedAt ??= 0
      this.state.accounts[account.id] = state
      const runtime: TraeAccountRuntime = { config: account, state }
      this.ensureAuth(runtime)
      return runtime
    })
    const active = new Set(accountFiles.map((account) => account.id))
    for (const id of Object.keys(this.state.accounts)) {
      if (!active.has(id)) delete this.state.accounts[id]
    }
    this.onStateChanged()
  }

  listAccounts(): TraeAccountRuntime[] {
    return this.accounts.map((runtime) => ({
      ...runtime,
      config: redactAccount(runtime.config),
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

  async getAccountForModel(
    model: string,
    exclude = new Set<string>()
  ): Promise<TraeAccountRuntime | undefined> {
    if (!this.accounts.length) return undefined
    const now = Date.now()
    const normalized = normalizeTraeModel(model || DEFAULT_TRAE_MODEL)
    const start = this.currentAccountIndex % this.accounts.length
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < this.accounts.length; i++) {
        const idx = (start + i) % this.accounts.length
        const account = this.accounts[idx]
        if (account.config.enabled === false || exclude.has(account.config.id)) continue
        if (pass === 0 && !this.isAvailable(account, now)) continue
        if (pass === 1 && isHardOffline(account.state.status)) continue
        if (!this.accountHasModel(account, normalized)) continue
        if (!(await this.tryEnsureAuth(account))) continue
        this.currentAccountIndex = idx
        this.state.currentAccountIndex = idx
        this.onStateChanged()
        return account
      }
    }
    return undefined
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

  async reportSuccess(account: TraeAccountRuntime): Promise<void> {
    account.state.failures = 0
    account.state.lastError = undefined
    account.state.lastSuccessAt = Date.now()
    account.state.stats.totalRequests += 1
    account.state.stats.successfulRequests += 1
    account.state.lastResponseKind = 'success'
    this.transitionStatus(account, 'available')
    this.onStateChanged()
  }

  async reportFailure(
    account: TraeAccountRuntime,
    error: unknown,
    classified: TraeClassifiedError
  ): Promise<void> {
    account.state.failures += 1
    account.state.lastFailureAt = Date.now()
    account.state.lastError = toErrorMessage(error)
    account.state.stats.totalRequests += 1
    account.state.stats.failedRequests += 1
    account.state.lastResponseKind = classified.kind
    const now = Date.now()
    const reason = account.state.lastError.slice(0, 200)
    if (classified.kind === 'auth') this.transitionStatus(account, 'auth_failed', reason)
    else if (classified.kind === 'quota')
      this.transitionStatus(account, 'quota_exceeded', reason, now + classified.cooldownMs)
    else if (classified.kind === 'rate_limit')
      this.transitionStatus(account, 'rate_limited', reason, now + classified.cooldownMs)
    else {
      const multiplier = Math.min(64, Math.pow(2, Math.max(0, account.state.failures - 1)))
      this.transitionStatus(account, 'cooling', reason, now + classified.cooldownMs * multiplier)
    }
    this.logger.warn(account.state.lastError, {
      provider: 'trae',
      accountId: accountLabel(account),
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
    this.transitionStatus(account, 'available')
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
    this.onStateChanged()
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
        accountId: accountLabel(account),
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

  private accountHasModel(account: TraeAccountRuntime, model: string): boolean {
    const list = account.state.modelIds || []
    if (!list.length) return true
    const normalized = normalizeTraeModel(model)
    return list.some((available) => normalizeTraeModel(available) === normalized)
  }

  private modelsForAccount(account?: TraeAccountConfig): string[] {
    const includeUnavailableInUS =
      this.config.settings.exposeUnavailableInUS ||
      Boolean(account?.countryCode && account.countryCode !== 'US')
    return listTraeBuiltInModelIds({ includeUnavailableInUS })
  }

  private isAvailable(account: TraeAccountRuntime, now: number): boolean {
    const status = account.state.status
    if (status === 'available') return true
    if (isHardOffline(status)) return false
    if (account.state.cooldownUntil && now > account.state.cooldownUntil) return true
    return Math.random() < 0.1
  }

  private transitionStatus(
    account: TraeAccountRuntime,
    status: AccountStatus,
    reason?: string,
    cooldownUntil?: number
  ): void {
    account.state.status = status
    account.state.statusReason = reason
    account.state.statusUpdatedAt = Date.now()
    account.state.cooldownUntil = cooldownUntil
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

function defaultAccountState(modelIds = listTraeBuiltInModelIds()): AccountRuntimeState {
  return {
    failures: 0,
    lastFailureAt: 0,
    lastSuccessAt: 0,
    modelsCachedAt: 0,
    modelIds,
    status: 'available',
    statusUpdatedAt: 0,
    stats: { totalRequests: 0, successfulRequests: 0, failedRequests: 0 }
  }
}

function sanitizeUsableModelIds(modelIds: string[]): string[] {
  const set = new Set<string>()
  for (const modelId of modelIds) {
    const normalized = normalizeTraeModel(modelId)
    if (describeTraeModel(normalized)) set.add(normalized)
  }
  return [...set].sort()
}

function isHardOffline(status: AccountStatus): boolean {
  return status === 'auth_failed' || status === 'manual_disabled' || status === 'quota_exceeded'
}

function redactAccount(account: TraeAccountConfig): TraeAccountConfig {
  return {
    ...account,
    jwtToken: account.jwtToken ? '***' : undefined,
    refreshToken: account.refreshToken ? '***' : undefined
  }
}

function applyTokenSnapshot(account: TraeAccountConfig, snapshot: TraeTokenSnapshot): void {
  if (snapshot.jwtToken) account.jwtToken = snapshot.jwtToken
  if (snapshot.refreshToken) account.refreshToken = snapshot.refreshToken
  if (snapshot.tokenExpiresAt) account.tokenExpiresAt = snapshot.tokenExpiresAt
  if (snapshot.refreshExpiresAt) account.refreshExpiresAt = snapshot.refreshExpiresAt
}

function accountLabel(account: TraeAccountRuntime): string {
  return account.config.email || account.config.label || account.config.id
}

export const TRAE_MODEL_DOCS = TRAE_BUILT_IN_MODELS
