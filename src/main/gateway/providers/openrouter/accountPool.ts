import type {
  AccountRuntimeState,
  AccountStatus,
  AccountTestResult,
  OpenRouterAccountConfig,
  OpenRouterProviderConfig,
  OpenRouterProviderState,
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
  OPENROUTER_BASE_URL,
  OPENROUTER_FREE_ROUTER_MODEL,
  OPENROUTER_KEY_PATH,
  OPENROUTER_MODELS_PATH
} from './constants'
import {
  clampRequestRaceMaxConcurrent,
  recordAccountRaceFailure,
  recordAccountRaceSuccess,
  scoreAccountForRace
} from '../requestRace'

export type OpenRouterAccountRuntime = AccountWithState<OpenRouterAccountConfig>

export interface OpenRouterClassifiedError extends ClassifiedError {}

export interface OpenRouterKeyInfo {
  label?: string
  limit?: number | null
  limit_remaining?: number | null
  usage?: number
  is_free_tier?: boolean
}

interface OpenRouterModelInfo {
  id: string
  pricing?: {
    prompt?: string | number
    completion?: string | number
  }
}

const MODELS_CACHE_TTL_MS = 30 * 60_000

export class OpenRouterAccountPool extends BaseAccountPool<OpenRouterAccountConfig> {
  protected providerName = 'openrouter'

  constructor(
    private readonly providerConfig: OpenRouterProviderConfig,
    private readonly providerState: OpenRouterProviderState,
    logger: GatewayLogger,
    onStateChanged: () => void,
    private readonly persistAccount?: (
      accountId: string,
      updates: Partial<OpenRouterAccountConfig>
    ) => Promise<void>
  ) {
    super(logger, onStateChanged)
    this.currentAccountIndex = providerState.currentAccountIndex || 0
  }

  // --- state-store wiring ---

  protected lookupState(accountId: string): AccountRuntimeState | undefined {
    return this.providerState.accounts[accountId]
  }
  protected storeState(accountId: string, state: AccountRuntimeState): void {
    this.providerState.accounts[accountId] = state
  }
  protected deleteState(accountId: string): void {
    delete this.providerState.accounts[accountId]
  }
  protected stateIds(): string[] {
    return Object.keys(this.providerState.accounts)
  }
  protected setCurrentIndex(index: number): void {
    this.providerState.currentAccountIndex = index
  }

  // --- model hooks ---

  protected normalizeModel(model: string): string {
    return normalizeOpenRouterModel(model)
  }
  protected accountHasModel(account: OpenRouterAccountRuntime, model: string): boolean {
    const list = account.state.modelIds || []
    if (!list.length) return false
    return list.some((available) => normalizeOpenRouterModel(available) === model)
  }
  protected redactSecrets(config: OpenRouterAccountConfig): OpenRouterAccountConfig {
    return { ...config, apiKey: config.apiKey ? '***' : undefined }
  }

  // --- account selection (race-aware override) ---

  async getAccountForModel(
    model: string,
    exclude = new Set<string>()
  ): Promise<OpenRouterAccountRuntime | undefined> {
    return this.pickAccountTwoPass(model, exclude, (account) =>
      this.maybeRefreshAccountModels(account)
    )
  }

  async getRaceAccountsForModel(
    model: string,
    maxConcurrent: number
  ): Promise<OpenRouterAccountRuntime[]> {
    if (!this.accounts.length) return []
    const normalizedModel = normalizeOpenRouterModel(model)
    const max = clampRequestRaceMaxConcurrent(maxConcurrent)
    const eligible: Array<{ account: OpenRouterAccountRuntime; index: number }> = []
    const now = Date.now()

    for (let index = 0; index < this.accounts.length; index++) {
      const account = this.accounts[index]
      if (account.config.enabled === false) continue
      if (this.isHardOffline(account.state.status)) continue
      if (!this.isAvailable(account, now)) continue
      await this.maybeRefreshAccountModels(account)
      if (!this.accountHasModel(account, normalizedModel)) continue
      eligible.push({ account, index })
    }
    if (!eligible.length) return []
    if (eligible.length < 2) return eligible.map((candidate) => candidate.account)

    const start = this.currentAccountIndex % this.accounts.length
    let roundRobin = eligible.find(({ index }) => index >= start)
    if (!roundRobin) roundRobin = eligible[0]

    this.currentAccountIndex = (roundRobin.index + 1) % this.accounts.length
    this.providerState.currentAccountIndex = this.currentAccountIndex

    const selected = [
      roundRobin,
      ...eligible
        .filter((candidate) => candidate.account.config.id !== roundRobin!.account.config.id)
        .sort((a, b) => scoreAccountForRace(b.account.state) - scoreAccountForRace(a.account.state))
    ]
      .slice(0, max)
      .map((candidate) => candidate.account)

    this.onStateChanged()
    return selected
  }

  // --- race-aware reporting overrides ---

  async reportSuccess(account: OpenRouterAccountRuntime, latencyMs?: number): Promise<void> {
    await super.reportSuccess(account, latencyMs)
    recordAccountRaceSuccess(account.state, latencyMs)
  }

  async reportFailure(
    account: OpenRouterAccountRuntime,
    error: unknown,
    classified: OpenRouterClassifiedError
  ): Promise<void> {
    // base reportFailure handles counters + transitionStatus + logging;
    // we add the race-failure side-effect before the base mutates cooldowns.
    recordAccountRaceFailure(account.state, classified.kind)
    await super.reportFailure(account, error, classified)
  }

  // --- HTTP-specific surface (unchanged) ---

  async listModelsFresh(): Promise<string[]> {
    await Promise.allSettled(
      this.accounts
        .filter((a) => a.config.enabled !== false)
        .map((a) => this.maybeRefreshAccountModels(a))
    )
    return this.listModels()
  }

  async testAccount(accountId: string): Promise<AccountTestResult> {
    const account = this.accounts.find((a) => a.config.id === accountId)
    if (!account) return { ok: false, accountId, message: 'Account not found' }
    try {
      const { models, keyInfo } = await this.refreshAccountModels(account)
      this.transitionStatus(account, 'available', undefined)
      this.onStateChanged()
      return {
        ok: true,
        accountId,
        message: `OpenRouter key valid, ${models.length} ${keyInfo.is_free_tier ? 'free-tier' : 'paid'} model(s) available`,
        models: models.slice(0, 50),
        authType: 'openrouter-api-key'
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
    const account = this.accounts.find((a) => a.config.id === accountId)
    if (!account) throw new Error('Account not found')
    await this.maybeRefreshAccountModels(account)
    let keyInfo: any = {}
    try {
      const baseUrl = this.providerConfig.settings.baseUrl || OPENROUTER_BASE_URL
      const res = await fetch(joinUrl(baseUrl, OPENROUTER_KEY_PATH), {
        headers: { Authorization: `Bearer ${account.config.apiKey}` }
      })
      if (res.ok) keyInfo = await res.json()
    } catch {
      /* ignore */
    }
    return {
      subscription: { title: 'OpenRouter', type: keyInfo.data?.label || 'api-key' },
      email: undefined,
      keyInfo: keyInfo.data,
      tier: account.config.isFreeTier ? 'free' : 'paid',
      limitRemaining: account.config.limitRemaining,
      models: (account.state.modelIds || []).slice(0, 100).map((model) => ({
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
    await this.refreshAccountModels(account)
    return { models: account.state.modelIds }
  }

  private async maybeRefreshAccountModels(account: OpenRouterAccountRuntime): Promise<void> {
    const now = Date.now()
    if (
      account.state.modelsCachedAt &&
      now - account.state.modelsCachedAt < MODELS_CACHE_TTL_MS &&
      account.state.modelIds?.length
    ) {
      return
    }
    try {
      await this.refreshAccountModels(account)
    } catch (error) {
      const classified = classifyOpenRouterError(0, toErrorMessage(error))
      if (classified.kind === 'auth')
        this.transitionStatus(account, 'auth_failed', toErrorMessage(error).slice(0, 200))
      this.logger.warn(`OpenRouter model refresh failed: ${toErrorMessage(error)}`, {
        provider: 'openrouter',
        accountId: this.accountLabel(account),
        category: 'account'
      })
      this.onStateChanged()
    }
  }

  private async refreshAccountModels(
    account: OpenRouterAccountRuntime
  ): Promise<{ models: string[]; keyInfo: OpenRouterKeyInfo }> {
    const keyInfo = await this.fetchKeyInfo(account)
    const allModels = await this.fetchModels(account)
    const models = filterModelsForKey(allModels, keyInfo)
    account.state.modelIds = models
    account.state.modelsCachedAt = Date.now()
    applyKeyInfo(account.config, keyInfo)
    await this.persistAccount?.(account.config.id, {
      keyLabel: account.config.keyLabel,
      isFreeTier: account.config.isFreeTier,
      limit: account.config.limit,
      limitRemaining: account.config.limitRemaining,
      usage: account.config.usage,
      lastKeyInfoAt: account.config.lastKeyInfoAt
    })
    this.onStateChanged()
    return { models, keyInfo }
  }

  private async fetchKeyInfo(account: OpenRouterAccountRuntime): Promise<OpenRouterKeyInfo> {
    const baseUrl = this.providerConfig.settings.baseUrl || OPENROUTER_BASE_URL
    const res = await fetchWithTimeout(joinUrl(baseUrl, OPENROUTER_KEY_PATH), {
      headers: { Authorization: `Bearer ${account.config.apiKey}` },
      timeoutMs: 20_000
    })
    const text = await res.text()
    const payload = parseJson(text)
    if (!res.ok || payload?.error) {
      throw new Error(
        `OpenRouter key check failed: HTTP ${res.status} ${redactOpenRouterKey(text).slice(0, 500)}`
      )
    }
    return payload?.data || {}
  }

  private async fetchModels(account: OpenRouterAccountRuntime): Promise<OpenRouterModelInfo[]> {
    const baseUrl = this.providerConfig.settings.baseUrl || OPENROUTER_BASE_URL
    const res = await fetchWithTimeout(joinUrl(baseUrl, OPENROUTER_MODELS_PATH), {
      headers: { Authorization: `Bearer ${account.config.apiKey}` },
      timeoutMs: 30_000
    })
    const text = await res.text()
    const payload = parseJson(text)
    if (!res.ok || payload?.error) {
      throw new Error(
        `OpenRouter model list failed: HTTP ${res.status} ${redactOpenRouterKey(text).slice(0, 500)}`
      )
    }
    return Array.isArray(payload?.data) ? payload.data : []
  }
}

// re-exported type alias used by classifyOpenRouterError consumers
export type { AccountStatus, ResponseKind }

export function classifyOpenRouterError(status: number, body: string): OpenRouterClassifiedError {
  const msg = body.toLowerCase()
  if (status === 401 || status === 403 || /http 40[13]|invalid.*key|unauthorized/.test(msg)) {
    return { kind: 'auth', cooldownMs: 0 }
  }
  if (status === 402 || /payment required|negative credit|insufficient.*credit/.test(msg)) {
    return { kind: 'quota', cooldownMs: 60 * 60_000 }
  }
  if (status === 429 || /rate limit|too many requests/.test(msg)) {
    return { kind: 'rate_limit', cooldownMs: 60_000 }
  }
  if (/quota|credits|insufficient|exceeded/.test(msg)) {
    return { kind: 'quota', cooldownMs: 60 * 60_000 }
  }
  if (/timeout/.test(msg)) return { kind: 'timeout', cooldownMs: 30_000 }
  if (status >= 500) return { kind: 'server_error', cooldownMs: 30_000 }
  return { kind: 'server_error', cooldownMs: 15_000 }
}

function applyKeyInfo(account: OpenRouterAccountConfig, keyInfo: OpenRouterKeyInfo): void {
  account.keyLabel = keyInfo.label || account.keyLabel
  account.isFreeTier = keyInfo.is_free_tier === true
  account.limit = keyInfo.limit ?? null
  account.limitRemaining = keyInfo.limit_remaining ?? null
  account.usage = Number(keyInfo.usage ?? account.usage ?? 0)
  account.lastKeyInfoAt = Date.now()
}

export function filterModelsForKey(
  models: OpenRouterModelInfo[],
  keyInfo: OpenRouterKeyInfo
): string[] {
  const isFreeTier = keyInfo.is_free_tier === true
  const ids = models
    .map((model) => normalizeOpenRouterModel(model.id))
    .filter((id) => id && (!isFreeTier || isFreeModelId(id)))
  if (isFreeTier) ids.push(OPENROUTER_FREE_ROUTER_MODEL)
  return [...new Set(ids)].sort()
}

function isFreeModelId(id: string): boolean {
  return (
    id.endsWith(':free') || id === OPENROUTER_FREE_ROUTER_MODEL || id === 'openrouter/auto:free'
  )
}

function normalizeOpenRouterModel(model: string): string {
  return String(model || '').trim()
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

async function fetchWithTimeout(
  url: string,
  options: { headers?: Record<string, string>; timeoutMs: number }
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    return await fetch(url, { headers: options.headers, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function parseJson(text: string): any {
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { rawText: text }
  }
}

function redactOpenRouterKey(text: string): string {
  return text.replace(/sk-or-v1-[A-Za-z0-9_-]+/g, 'sk-or-v1-***')
}
