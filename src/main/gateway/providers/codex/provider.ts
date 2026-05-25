import type {
  AccountStatus,
  AccountTestResult,
  CodexAccountConfig,
  CodexProviderConfig,
  CodexProviderState,
  GatewayRequestContext,
  GatewayResponse,
  ProviderAdapter,
  ProviderModel,
  ProviderStatus,
  UsageMeta,
  UsageStats
} from '../../types'
import { GatewayLogger } from '../../core/logger'
import { jsonResponse, sleep, sseData, toErrorMessage } from '../../core/utils'
import { codexFetch } from './auth'
import {
  CodexAccountPool,
  type CodexAccountRuntime,
  type CodexClassifiedError
} from './accountPool'
import { codexResponsesUrl, DEFAULT_CODEX_MODEL, normalizeCodexModel } from './constants'
import { anthropicToResponsesPayload, chatToResponsesPayload } from './converters'
import {
  FirstTokenTimeoutError,
  anthropicJsonFromCodex,
  anthropicSseFromCodex,
  openAiJsonFromCodex,
  openAiSseFromCodex
} from './streaming'
import type { CodexAccountInfo } from './types'

const UPSTREAM_META = { category: 'upstream' as const, provider: 'codex' as const }

class NonRetryableCodexError extends Error {}

function accountLabel(account: CodexAccountRuntime): string {
  return account.config.email || account.config.label || account.config.id
}

export class CodexProvider implements ProviderAdapter {
  readonly name = 'codex'
  private readonly pool: CodexAccountPool

  constructor(
    private readonly config: CodexProviderConfig,
    state: CodexProviderState,
    private readonly logger: GatewayLogger,
    onStateChanged: () => void,
    persistAccount?: (accountId: string, updates: Partial<CodexAccountConfig>) => Promise<void>
  ) {
    this.pool = new CodexAccountPool(config, state, logger, onStateChanged, persistAccount)
  }

  async initialize(accountFiles: CodexAccountConfig[]): Promise<void> {
    await this.pool.reload(accountFiles)
  }

  async listModels(): Promise<ProviderModel[]> {
    return this.pool.listModels().map((id) => ({
      id,
      provider: 'codex',
      ownedBy: 'codex',
      description: 'Model via Codex (ChatGPT) provider'
    }))
  }

  async chatCompletions(body: any, context: GatewayRequestContext): Promise<GatewayResponse> {
    const model = normalizeCodexModel(String(body.model || DEFAULT_CODEX_MODEL))
    const stream = body.stream !== false
    if (stream) {
      return {
        status: 200,
        headers: sseHeaders(),
        stream: this.streamWithFailover('openai', model, body, context.requestId, context.onUsage)
      }
    }
    const result = await this.nonStreamWithFailover(
      'openai',
      model,
      body,
      context.requestId,
      context.onUsage
    )
    return jsonResponse(200, result)
  }

  async messages(body: any, context: GatewayRequestContext): Promise<GatewayResponse> {
    const model = normalizeCodexModel(String(body.model || DEFAULT_CODEX_MODEL))
    const stream = body.stream === true
    if (stream) {
      return {
        status: 200,
        headers: sseHeaders(),
        stream: this.streamWithFailover(
          'anthropic',
          model,
          body,
          context.requestId,
          context.onUsage
        )
      }
    }
    const result = await this.nonStreamWithFailover(
      'anthropic',
      model,
      body,
      context.requestId,
      context.onUsage
    )
    return jsonResponse(200, result)
  }

  async testAccount(accountId: string): Promise<AccountTestResult> {
    return this.pool.testAccount(accountId)
  }

  async getAccountInfo(accountId: string): Promise<CodexAccountInfo> {
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
      label: account.config.email || account.config.label,
      email: account.config.email,
      enabled: account.config.enabled !== false,
      failures: account.state.failures,
      lastError: account.state.lastError,
      lastSuccessAt: account.state.lastSuccessAt,
      lastFailureAt: account.state.lastFailureAt,
      models: account.state.modelIds,
      stats: account.state.stats,
      authType: account.auth?.authType ?? 'chatgpt-oauth',
      expiresAt: account.auth?.expiresAtIso,
      status: account.state.status,
      statusReason: account.state.statusReason,
      statusUpdatedAt: account.state.statusUpdatedAt,
      cooldownUntil: account.state.cooldownUntil,
      lastResponseKind: account.state.lastResponseKind,
      chatgptAccountId: account.config.chatgptAccountId,
      subscriptionActiveUntil: account.config.subscriptionActiveUntil
    }))
    return {
      name: 'codex',
      providerType: 'codex',
      enabled: this.config.enabled,
      configured: accounts.length > 0,
      status: !this.config.enabled ? 'disabled' : accounts.length ? 'ready' : 'error',
      message: accounts.length ? `${accounts.length} account(s)` : 'No Codex accounts configured',
      models: this.pool.listModels(),
      accounts
    }
  }

  // ============== streaming / non-streaming with failover ==============

  private async nonStreamWithFailover(
    format: 'openai' | 'anthropic',
    model: string,
    body: any,
    rid: string,
    onUsage?: (u: UsageStats, meta?: UsageMeta) => void
  ): Promise<any> {
    const excluded = new Set<string>()
    let lastError: unknown
    const total = this.pool.listAccounts().length
    for (let attempt = 0; attempt < Math.max(1, total); attempt++) {
      const account = await this.pool.getAccountForModel(model, excluded)
      if (!account) break
      const sink = onUsage
        ? (u: UsageStats) => onUsage(u, { accountId: account.config.id, model, provider: 'codex' })
        : undefined
      const startedAt = Date.now()
      try {
        const payload =
          format === 'openai' ? chatToResponsesPayload(body) : anthropicToResponsesPayload(body)
        const response = await this.callCodex(account, payload)
        if (!response.body) throw new Error('Codex response body is empty')
        const result =
          format === 'openai'
            ? await openAiJsonFromCodex(
                response.body,
                model,
                this.config.settings.firstTokenTimeoutSeconds,
                sink
              )
            : await anthropicJsonFromCodex(
                response.body,
                model,
                this.config.settings.firstTokenTimeoutSeconds,
                sink
              )
        await this.pool.reportSuccess(account)
        this.logger.info(`Codex upstream success`, {
          ...UPSTREAM_META,
          requestId: rid,
          accountId: accountLabel(account),
          duration: Date.now() - startedAt
        })
        return result
      } catch (error) {
        lastError = error
        const errMsg = toErrorMessage(error)
        const classified = classifyCodexError(error)
        await this.pool.reportFailure(account, error, classified)
        excluded.add(account.config.id)
        this.logger.warn(`Codex upstream failed: ${errMsg}`, {
          ...UPSTREAM_META,
          requestId: rid,
          accountId: accountLabel(account),
          duration: Date.now() - startedAt,
          error: { upstreamBody: errMsg.slice(0, 500) },
          extra: { kind: classified.kind, attempt: attempt + 1 }
        })
      }
    }
    this.logger.error(`Codex upstream attempts exhausted for model=${model}`, {
      ...UPSTREAM_META,
      requestId: rid
    })
    throw new Error(`Codex request failed: ${toErrorMessage(lastError ?? 'No available accounts')}`)
  }

  private async *streamWithFailover(
    format: 'openai' | 'anthropic',
    model: string,
    body: any,
    rid: string,
    onUsage?: (u: UsageStats, meta?: UsageMeta) => void
  ): AsyncGenerator<string> {
    const excluded = new Set<string>()
    let lastError: unknown
    const total = this.pool.listAccounts().length
    for (let attempt = 0; attempt < Math.max(1, total); attempt++) {
      const account = await this.pool.getAccountForModel(model, excluded)
      if (!account) break
      const sink = onUsage
        ? (u: UsageStats) => onUsage(u, { accountId: account.config.id, model, provider: 'codex' })
        : undefined
      const startedAt = Date.now()
      try {
        const payload =
          format === 'openai' ? chatToResponsesPayload(body) : anthropicToResponsesPayload(body)
        const response = await this.callCodex(account, payload)
        if (!response.body) throw new Error('Codex response body is empty')
        if (format === 'openai')
          yield* openAiSseFromCodex(
            response.body,
            model,
            this.config.settings.firstTokenTimeoutSeconds,
            sink
          )
        else
          yield* anthropicSseFromCodex(
            response.body,
            model,
            this.config.settings.firstTokenTimeoutSeconds,
            sink
          )
        await this.pool.reportSuccess(account)
        this.logger.info(`Codex stream success`, {
          ...UPSTREAM_META,
          requestId: rid,
          accountId: accountLabel(account),
          duration: Date.now() - startedAt
        })
        return
      } catch (error) {
        lastError = error
        const errMsg = toErrorMessage(error)
        const classified = classifyCodexError(error)
        await this.pool.reportFailure(account, error, classified)
        excluded.add(account.config.id)
        this.logger.warn(`Codex stream failed: ${errMsg}`, {
          ...UPSTREAM_META,
          requestId: rid,
          accountId: accountLabel(account),
          duration: Date.now() - startedAt,
          error: { upstreamBody: errMsg.slice(0, 500) },
          extra: { kind: classified.kind, attempt: attempt + 1 }
        })
        // 只有 first-token timeout 才有意义换号重试，其他错误直接停止以免重复输出
        if (!(error instanceof FirstTokenTimeoutError)) break
      }
    }

    const message = `Codex stream failed: ${toErrorMessage(lastError ?? 'No available accounts')}`
    if (format === 'openai') {
      yield sseData({ error: { message, type: 'gateway_error', code: 'codex_error' } })
      yield 'data: [DONE]\n\n'
    } else {
      yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`
    }
  }

  private async callCodex(account: CodexAccountRuntime, payload: any): Promise<Response> {
    if (!account.auth) throw new Error('Codex account is not initialized')
    const url = codexResponsesUrl(this.config.settings.baseUrl)
    let lastError: unknown
    for (let attempt = 0; attempt < Math.max(1, this.config.settings.maxRetries); attempt++) {
      try {
        const token = await account.auth.getAccessToken()
        const response = await codexFetch(
          url,
          {
            method: 'POST',
            headers: { ...account.auth.buildHeaders(token), accept: 'text/event-stream' },
            body: JSON.stringify(payload)
          },
          this.config.settings.vpnProxyUrl
        )
        if ((response.status === 401 || response.status === 403) && attempt === 0) {
          await account.auth.forceRefresh()
          continue
        }
        if (response.ok) return response
        const text = await response.text().catch(() => '')
        const message = `Codex HTTP ${response.status}: ${text.slice(0, 1000)}`
        lastError = new Error(message)
        if (response.status === 429 || response.status >= 500) {
          await sleep(500 * Math.pow(2, attempt))
          continue
        }
        throw new NonRetryableCodexError(message)
      } catch (error) {
        lastError = error
        if (error instanceof NonRetryableCodexError) throw error
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

export function classifyCodexError(error: unknown): CodexClassifiedError {
  const raw = error instanceof Error ? error.message : String(error)
  const msg = raw.toLowerCase()
  const statusMatch = msg.match(/codex http (\d{3})/)
  const status = statusMatch ? Number(statusMatch[1]) : 0
  if (
    msg.includes('refresh token') ||
    msg.includes('access token') ||
    msg.includes('chatgpt-account-id')
  ) {
    return { kind: 'auth', cooldownMs: 0 }
  }
  if (status === 401 || status === 403) return { kind: 'auth', cooldownMs: 0 }
  if (status === 429) {
    if (/quota|usage limit|exceeded/.test(msg)) return { kind: 'quota', cooldownMs: 60 * 60_000 }
    return { kind: 'rate_limit', cooldownMs: 60_000 }
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
