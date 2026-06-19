import type {
  AccountRuntimeState,
  AccountTestResult,
  NvidiaAccountConfig,
  NvidiaProviderConfig,
  NvidiaProviderState
} from '../../types'
import { GatewayLogger } from '../../core/logger'
import { toErrorMessage } from '../../core/utils'
import {
  BaseAccountPool,
  type AccountWithState,
  type ClassifiedError
} from '../../core/accountPool'
import { NVIDIA_BASE_URL, NVIDIA_DEFAULT_SMOKE_MODEL, NVIDIA_MODELS_PATH } from './constants'
import {
  clampRequestRaceMaxConcurrent,
  recordAccountRaceFailure,
  recordAccountRaceSuccess,
  scoreAccountForRace
} from '../requestRace'

export type NvidiaAccountRuntime = AccountWithState<NvidiaAccountConfig>

export interface NvidiaClassifiedError extends ClassifiedError {}

export interface NvidiaKeyInfo {
  label?: string
  checkedAt?: number
}

interface NvidiaModelInfo {
  id: string
  owned_by?: string
  object?: string
}

const MODELS_CACHE_TTL_MS = 30 * 60_000

export class NvidiaAccountPool extends BaseAccountPool<NvidiaAccountConfig> {
  protected providerName = 'nvidia'

  constructor(
    private readonly providerConfig: NvidiaProviderConfig,
    private readonly providerState: NvidiaProviderState,
    logger: GatewayLogger,
    onStateChanged: () => void,
    private readonly persistAccount?: (
      accountId: string,
      updates: Partial<NvidiaAccountConfig>
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
    return normalizeNvidiaModel(model)
  }
  protected accountHasModel(account: NvidiaAccountRuntime, model: string): boolean {
    const list = account.state.modelIds || []
    if (!list.length) return false
    return list.some((available) => normalizeNvidiaModel(available) === model)
  }
  protected redactSecrets(config: NvidiaAccountConfig): NvidiaAccountConfig {
    return { ...config, apiKey: config.apiKey ? '***' : undefined }
  }

  // --- account selection ---

  async getAccountForModel(
    model: string,
    exclude = new Set<string>()
  ): Promise<NvidiaAccountRuntime | undefined> {
    return this.pickAccountTwoPass(model, exclude, (account) =>
      this.maybeRefreshAccountModels(account)
    )
  }

  async getRaceAccountsForModel(
    model: string,
    maxConcurrent: number
  ): Promise<NvidiaAccountRuntime[]> {
    if (!this.accounts.length) return []
    const normalizedModel = normalizeNvidiaModel(model)
    const max = clampRequestRaceMaxConcurrent(maxConcurrent)
    const eligible: Array<{ account: NvidiaAccountRuntime; index: number }> = []
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

  async reportSuccess(account: NvidiaAccountRuntime, latencyMs?: number): Promise<void> {
    await super.reportSuccess(account, latencyMs)
    recordAccountRaceSuccess(account.state, latencyMs)
  }

  async reportFailure(
    account: NvidiaAccountRuntime,
    error: unknown,
    classified: NvidiaClassifiedError
  ): Promise<void> {
    recordAccountRaceFailure(account.state, classified.kind)
    await super.reportFailure(account, error, classified)
  }

  // --- HTTP-specific surface ---

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
      await this.checkApiKey(account)
      const { models } = await this.refreshAccountModels(account)
      this.transitionStatus(account, 'available', undefined)
      this.onStateChanged()
      return {
        ok: true,
        accountId,
        message: `NVIDIA key valid, ${models.length} model(s) discovered from /models`,
        models: models.slice(0, 50),
        authType: 'nvidia-api-key'
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
    return {
      subscription: { title: 'NVIDIA NIM', type: account.config.keyLabel || 'api-key' },
      email: undefined,
      keyInfo: {
        baseUrl: this.providerConfig.settings.baseUrl || NVIDIA_BASE_URL,
        lastKeyInfoAt: account.config.lastKeyInfoAt
      },
      tier: 'api-key',
      limitRemaining: undefined,
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

  private async maybeRefreshAccountModels(account: NvidiaAccountRuntime): Promise<void> {
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
      const classified = classifyNvidiaError(0, toErrorMessage(error))
      if (classified.kind === 'auth')
        this.transitionStatus(account, 'auth_failed', toErrorMessage(error).slice(0, 200))
      this.logger.warn(`NVIDIA model refresh failed: ${toErrorMessage(error)}`, {
        provider: 'nvidia',
        accountId: this.accountLabel(account),
        category: 'account'
      })
      this.onStateChanged()
    }
  }

  private async refreshAccountModels(
    account: NvidiaAccountRuntime
  ): Promise<{ models: string[]; keyInfo: NvidiaKeyInfo }> {
    const allModels = await this.fetchModels(account)
    const models = filterModelsForKey(allModels)
    account.state.modelIds = models
    account.state.modelsCachedAt = Date.now()
    const keyInfo: NvidiaKeyInfo = {
      label: account.config.keyLabel || 'NVIDIA NIM',
      checkedAt: Date.now()
    }
    applyKeyInfo(account.config, keyInfo)
    await this.persistAccount?.(account.config.id, {
      keyLabel: account.config.keyLabel,
      lastKeyInfoAt: account.config.lastKeyInfoAt
    })
    this.onStateChanged()
    return { models, keyInfo }
  }

  private async fetchModels(account: NvidiaAccountRuntime): Promise<NvidiaModelInfo[]> {
    const baseUrl = this.providerConfig.settings.baseUrl || NVIDIA_BASE_URL
    const res = await fetchWithTimeout(joinUrl(baseUrl, NVIDIA_MODELS_PATH), {
      headers: { Authorization: `Bearer ${account.config.apiKey}` },
      timeoutMs: 30_000
    })
    const text = await res.text()
    const payload = parseJson(text)
    if (!res.ok || payload?.error) {
      throw new Error(
        `NVIDIA model list failed: HTTP ${res.status} ${redactNvidiaKey(text).slice(0, 500)}`
      )
    }
    return Array.isArray(payload?.data) ? payload.data : []
  }

  private async checkApiKey(account: NvidiaAccountRuntime): Promise<void> {
    const baseUrl = this.providerConfig.settings.baseUrl || NVIDIA_BASE_URL
    const res = await fetchWithTimeout(joinUrl(baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${account.config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: NVIDIA_DEFAULT_SMOKE_MODEL,
        max_tokens: 1,
        stream: false,
        messages: [{ role: 'user', content: 'Reply OK.' }]
      }),
      timeoutMs: this.providerConfig.settings.firstTokenTimeoutSeconds * 1000
    })
    const text = await res.text()
    const payload = parseJson(text)
    if (!res.ok || payload?.error) {
      throw new Error(
        `NVIDIA key check failed: HTTP ${res.status} ${redactNvidiaKey(text).slice(0, 500)}`
      )
    }
  }
}

export function classifyNvidiaError(status: number, body: string): NvidiaClassifiedError {
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

function applyKeyInfo(account: NvidiaAccountConfig, keyInfo: NvidiaKeyInfo): void {
  account.keyLabel = keyInfo.label || account.keyLabel
  account.lastKeyInfoAt = keyInfo.checkedAt ?? Date.now()
}

export function filterModelsForKey(models: NvidiaModelInfo[]): string[] {
  const ids = models
    .map((model) => normalizeNvidiaModel(model.id))
    .filter((id) => id && !isNonChatCatalogModel(id))
  return [...new Set(ids)].sort()
}

function isNonChatCatalogModel(id: string): boolean {
  return /(?:^|[/_.-])(bge|deplot|detector|embed|embedding|fuyu|flux|image|kosmos|multimodal|neva|nvclip|parse|rerank|retriever|reward|video|vision|vila|vl)(?:$|[/_.-])/.test(
    id
  )
}

function normalizeNvidiaModel(model: string): string {
  return String(model || '').trim()
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

async function fetchWithTimeout(
  url: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: string
    timeoutMs: number
  }
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    return await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: controller.signal
    })
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

function redactNvidiaKey(text: string): string {
  return text
    .replace(/nvapi-[A-Za-z0-9._-]+/g, 'nvapi-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
}
