import type {
  AccountStatus,
  AccountTestResult,
  ClassifiedKiroError,
  GatewayRequestContext,
  GatewayResponse,
  KiroAccountConfig,
  KiroProviderConfig,
  KiroProviderState,
  ProviderAdapter,
  ProviderModel,
  ProviderStatus,
  UsageMeta,
  UsageStats
} from '../../types'
import { GatewayLogger } from '../../core/logger'
import { jsonResponse, sseData, sleep, toErrorMessage } from '../../core/utils'
import { kiroFetch } from './auth'
import { DEFAULT_KIRO_MODEL, normalizeKiroModelId, toKiroModelId } from './constants'
import { KiroAccountPool, KiroAccountRuntime } from './accountPool'
import {
  anthropicInputTokens,
  buildKiroPayloadFromAnthropic,
  buildKiroPayloadFromOpenAI
} from './converters'
import type { AccountInfo } from './types'
import {
  FirstTokenTimeoutError,
  anthropicJsonFromKiro,
  anthropicSseFromKiro,
  openAiJsonFromKiro,
  openAiSseFromKiro
} from './streaming'

const UPSTREAM_META = { category: 'upstream' as const, provider: 'kiro' as const }

function accountLabel(account: KiroAccountRuntime): string {
  return account.config.email || account.config.label || account.config.id
}

class NonRetryableKiroError extends Error {}

export class KiroProvider implements ProviderAdapter {
  readonly name = 'kiro'
  private readonly pool: KiroAccountPool

  constructor(
    private readonly config: KiroProviderConfig,
    state: KiroProviderState,
    private readonly logger: GatewayLogger,
    onStateChanged: () => void
  ) {
    this.pool = new KiroAccountPool(config, state, logger, onStateChanged)
  }

  async initialize(accountFiles: KiroAccountConfig[]): Promise<void> {
    await this.pool.reload(accountFiles)
  }

  async listModels(): Promise<ProviderModel[]> {
    return this.pool.listModels().map((id) => ({
      id,
      provider: 'kiro',
      ownedBy: 'kiro',
      description: 'Model via Kiro GatewayHub provider'
    }))
  }

  async chatCompletions(body: any, context: GatewayRequestContext): Promise<GatewayResponse> {
    const model = normalizeKiroModelId(String(body.model || DEFAULT_KIRO_MODEL))
    const kiroModel = toKiroModelId(model)
    const stream = body.stream !== false

    if (stream) {
      return {
        status: 200,
        headers: sseHeaders(),
        stream: this.streamWithFailover(
          'openai',
          model,
          kiroModel,
          body,
          context.requestId,
          context.onUsage
        )
      }
    }

    const result = await this.nonStreamWithFailover(
      'openai',
      model,
      kiroModel,
      body,
      context.requestId,
      context.onUsage
    )
    return jsonResponse(200, result)
  }

  async messages(body: any, context: GatewayRequestContext): Promise<GatewayResponse> {
    const model = normalizeKiroModelId(String(body.model || DEFAULT_KIRO_MODEL))
    const kiroModel = toKiroModelId(model)
    const stream = body.stream === true

    if (stream) {
      return {
        status: 200,
        headers: sseHeaders(),
        stream: this.streamWithFailover(
          'anthropic',
          model,
          kiroModel,
          body,
          context.requestId,
          context.onUsage
        )
      }
    }

    const result = await this.nonStreamWithFailover(
      'anthropic',
      model,
      kiroModel,
      body,
      context.requestId,
      context.onUsage
    )
    return jsonResponse(200, result)
  }

  async countTokens(body: any): Promise<GatewayResponse> {
    return jsonResponse(200, { input_tokens: anthropicInputTokens(body) })
  }

  async testAccount(accountId: string): Promise<AccountTestResult> {
    return this.pool.testAccount(accountId)
  }

  async getAccountInfo(accountId: string): Promise<AccountInfo> {
    return this.pool.getAccountInfo(accountId)
  }

  async resetAccount(accountId: string): Promise<void> {
    return this.pool.resetAccount(accountId)
  }

  async setAccountStatus(accountId: string, status: AccountStatus, reason?: string): Promise<void> {
    return this.pool.setAccountStatus(accountId, status, reason)
  }

  async getStatus(): Promise<ProviderStatus & { accounts: any[] }> {
    const accounts = this.pool.listAccounts().map((account) => ({
      id: account.config.id,
      label: account.config.label || account.config.email,
      email: account.config.email,
      enabled: account.config.enabled !== false,
      failures: account.state.failures,
      lastError: account.state.lastError,
      lastSuccessAt: account.state.lastSuccessAt,
      lastFailureAt: account.state.lastFailureAt,
      models: account.state.modelIds,
      stats: account.state.stats,
      authType: account.auth?.authType,
      expiresAt: account.auth?.expiresAtIso,
      status: account.state.status,
      statusReason: account.state.statusReason,
      statusUpdatedAt: account.state.statusUpdatedAt,
      cooldownUntil: account.state.cooldownUntil,
      lastResponseKind: account.state.lastResponseKind
    }))
    return {
      name: 'kiro',
      providerType: 'kiro',
      enabled: this.config.enabled,
      configured: accounts.length > 0,
      status: !this.config.enabled ? 'disabled' : accounts.length ? 'ready' : 'error',
      message: accounts.length ? `${accounts.length} account(s)` : 'No Kiro accounts configured',
      models: this.pool.listModels(),
      accounts
    }
  }

  private async nonStreamWithFailover(
    format: 'openai' | 'anthropic',
    model: string,
    kiroModel: string,
    body: any,
    rid: string,
    onUsage?: (u: UsageStats, meta?: UsageMeta) => void
  ): Promise<any> {
    const excluded = new Set<string>()
    let lastError: unknown
    const totalAccounts = this.pool.listAccounts().length
    for (let attempt = 0; attempt < Math.max(1, totalAccounts); attempt++) {
      const account = await this.pool.getAccountForModel(kiroModel, excluded)
      if (!account) break
      const attemptStart = Date.now()
      this.logger.debug(`Upstream attempt ${attempt + 1}/${totalAccounts}`, {
        ...UPSTREAM_META,
        requestId: rid,
        accountId: accountLabel(account)
      })
      const sink = onUsage
        ? (u: UsageStats) => onUsage(u, { accountId: account.config.id, model, provider: 'kiro' })
        : undefined
      try {
        const payload = this.buildPayload(format, body, model, account)
        const response = await this.callKiro(account, payload)
        if (!response.body) throw new Error('Kiro response body is empty')
        const result =
          format === 'openai'
            ? await openAiJsonFromKiro(
                response.body,
                model,
                body,
                this.config.settings.firstTokenTimeoutSeconds,
                sink,
                this.config.settings.streamingReadTimeoutSeconds
              )
            : await anthropicJsonFromKiro(
                response.body,
                model,
                body,
                this.config.settings.firstTokenTimeoutSeconds,
                sink,
                this.config.settings.streamingReadTimeoutSeconds
              )
        await this.pool.reportSuccess(account)
        this.logger.info(`Upstream success`, {
          ...UPSTREAM_META,
          requestId: rid,
          accountId: accountLabel(account),
          duration: Date.now() - attemptStart
        })
        return result
      } catch (error) {
        lastError = error
        const errMsg = toErrorMessage(error)
        const classified = classifyKiroError(error)
        if (classified.kind !== 'model_error') {
          await this.pool.reportFailure(account, error, classified)
          excluded.add(account.config.id)
        }
        this.logger.warn(`Upstream failed: ${errMsg}`, {
          ...UPSTREAM_META,
          requestId: rid,
          accountId: accountLabel(account),
          duration: Date.now() - attemptStart,
          error: { upstreamBody: errMsg.slice(0, 500) },
          extra: { kind: classified.kind, attempt: attempt + 1 }
        })
        if (classified.kind === 'model_error') break
      }
    }
    this.logger.error(`All upstream attempts exhausted for model=${kiroModel}`, {
      ...UPSTREAM_META,
      requestId: rid,
      extra: { totalAttempts: totalAccounts }
    })
    throw new Error(`Kiro request failed: ${toErrorMessage(lastError ?? 'No available accounts')}`)
  }

  private async *streamWithFailover(
    format: 'openai' | 'anthropic',
    model: string,
    kiroModel: string,
    body: any,
    rid: string,
    onUsage?: (u: UsageStats, meta?: UsageMeta) => void
  ): AsyncGenerator<string> {
    const excluded = new Set<string>()
    let lastError: unknown
    const totalAccounts = this.pool.listAccounts().length
    for (let attempt = 0; attempt < Math.max(1, totalAccounts); attempt++) {
      const account = await this.pool.getAccountForModel(kiroModel, excluded)
      if (!account) break
      const attemptStart = Date.now()
      this.logger.debug(`Upstream stream attempt ${attempt + 1}/${totalAccounts}`, {
        ...UPSTREAM_META,
        requestId: rid,
        accountId: accountLabel(account)
      })
      const sink = onUsage
        ? (u: UsageStats) => onUsage(u, { accountId: account.config.id, model, provider: 'kiro' })
        : undefined
      try {
        const payload = this.buildPayload(format, body, model, account)
        const response = await this.callKiro(account, payload)
        if (!response.body) throw new Error('Kiro response body is empty')
        if (format === 'openai')
          yield* openAiSseFromKiro(
            response.body,
            model,
            body,
            this.config.settings.firstTokenTimeoutSeconds,
            sink,
            this.config.settings.streamingReadTimeoutSeconds
          )
        else
          yield* anthropicSseFromKiro(
            response.body,
            model,
            body,
            this.config.settings.firstTokenTimeoutSeconds,
            sink,
            this.config.settings.streamingReadTimeoutSeconds
          )
        await this.pool.reportSuccess(account)
        this.logger.info(`Upstream stream success`, {
          ...UPSTREAM_META,
          requestId: rid,
          accountId: accountLabel(account),
          duration: Date.now() - attemptStart
        })
        return
      } catch (error) {
        lastError = error
        const errMsg = toErrorMessage(error)
        const classified = classifyKiroError(error)
        if (classified.kind !== 'model_error') {
          await this.pool.reportFailure(account, error, classified)
          excluded.add(account.config.id)
        }
        this.logger.warn(`Upstream stream failed: ${errMsg}`, {
          ...UPSTREAM_META,
          requestId: rid,
          accountId: accountLabel(account),
          duration: Date.now() - attemptStart,
          error: { upstreamBody: errMsg.slice(0, 500) },
          extra: { kind: classified.kind, attempt: attempt + 1 }
        })
        if (classified.kind === 'model_error' || !(error instanceof FirstTokenTimeoutError)) break
      }
    }

    this.logger.error(`All upstream stream attempts exhausted for model=${kiroModel}`, {
      ...UPSTREAM_META,
      requestId: rid,
      extra: { totalAttempts: totalAccounts }
    })

    const message = `Kiro stream failed: ${toErrorMessage(lastError ?? 'No available accounts')}`
    if (format === 'openai') {
      yield sseData({ error: { message, type: 'gateway_error', code: 'kiro_error' } })
      yield 'data: [DONE]\n\n'
    } else {
      yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`
    }
  }

  private buildPayload(
    format: 'openai' | 'anthropic',
    body: any,
    model: string,
    account: KiroAccountRuntime
  ): any {
    const profileArn = account.auth?.profileArn || account.config.profileArn || ''
    return format === 'openai'
      ? buildKiroPayloadFromOpenAI(body, model, profileArn)
      : buildKiroPayloadFromAnthropic(body, model, profileArn)
  }

  private async callKiro(account: KiroAccountRuntime, payload: any): Promise<Response> {
    if (!account.auth) throw new Error('Kiro account is not initialized')
    const url = `${account.auth.apiHost}/generateAssistantResponse`
    let lastError: unknown

    for (let attempt = 0; attempt < this.config.settings.maxRetries; attempt++) {
      try {
        const token = await account.auth.getAccessToken()
        const response = await kiroFetch(
          url,
          {
            method: 'POST',
            headers: { ...account.auth.buildHeaders(token), Connection: 'close' },
            body: JSON.stringify(payload)
          },
          this.config.settings.vpnProxyUrl
        )

        if (response.status === 403 && attempt === 0) {
          await account.auth.forceRefresh()
          continue
        }
        if (response.ok) return response
        const text = await response.text().catch(() => '')
        const message = `Kiro HTTP ${response.status}: ${text.slice(0, 1000)}`
        lastError = new Error(message)
        if (response.status === 429 || response.status >= 500) {
          await sleep(500 * Math.pow(2, attempt))
          continue
        }
        throw new NonRetryableKiroError(message)
      } catch (error) {
        lastError = error
        if (error instanceof NonRetryableKiroError) throw error
        if (attempt < this.config.settings.maxRetries - 1) {
          await sleep(500 * Math.pow(2, attempt))
          continue
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(toErrorMessage(lastError))
  }
}

function sseHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  }
}

export function classifyKiroError(error: unknown): ClassifiedKiroError {
  const raw = error instanceof Error ? error.message : String(error)
  const msg = raw.toLowerCase()
  const statusMatch = msg.match(/kiro http (\d{3})/)
  const status = statusMatch ? Number(statusMatch[1]) : 0

  // 凭证类问题：refresh/access token 缺失或刷新失败
  if (
    msg.includes('refresh token is missing') ||
    msg.includes('access token expired') ||
    msg.includes('access token is invalid') ||
    msg.includes('please add a new access token') ||
    msg.includes('token refresh failed') ||
    msg.includes('failed to obtain kiro access token')
  ) {
    return { kind: 'auth', cooldownMs: 0 }
  }
  if (status === 401 || status === 403) return { kind: 'auth', cooldownMs: 0 }

  if (status === 429) {
    if (/monthly|quota|usage limit|overage cap|monthly limit|throttling/.test(msg)) {
      return { kind: 'quota', cooldownMs: 60 * 60_000 }
    }
    return { kind: 'rate_limit', cooldownMs: 60_000 }
  }

  if (
    status === 400 &&
    (msg.includes('invalid_model_id') ||
      msg.includes('invalid model id') ||
      msg.includes('select a different model'))
  ) {
    return { kind: 'model_error', cooldownMs: 0 }
  }

  if (status >= 500 && status < 600) return { kind: 'server_error', cooldownMs: 30_000 }

  if (msg.includes('first token timeout') || msg.includes('timeout')) {
    return { kind: 'timeout', cooldownMs: 30_000 }
  }

  if (
    msg.includes('fetch failed') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('enotfound') ||
    msg.includes('network')
  ) {
    return { kind: 'network', cooldownMs: 15_000 }
  }

  return { kind: 'server_error', cooldownMs: 30_000 }
}
