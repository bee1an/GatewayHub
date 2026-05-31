import type {
  AccountStatus,
  AccountTestResult,
  GatewayRequestContext,
  GatewayResponse,
  OpenRouterAccountConfig,
  OpenRouterProviderConfig,
  OpenRouterProviderState,
  ProviderAdapter,
  ProviderModel,
  ProviderStatus,
  UsageStats
} from '../../types'
import { GatewayLogger } from '../../core/logger'
import { jsonResponse, sseData, sleep, toErrorMessage } from '../../core/utils'
import { OPENROUTER_BASE_URL, OPENROUTER_CHAT_COMPLETIONS_PATH } from './constants'
import {
  OpenRouterAccountPool,
  type OpenRouterAccountRuntime,
  classifyOpenRouterError
} from './accountPool'

const UPSTREAM_META = { category: 'upstream' as const, provider: 'openrouter' as const }

export class OpenRouterProvider implements ProviderAdapter {
  readonly name = 'openrouter'
  private readonly pool: OpenRouterAccountPool

  constructor(
    private readonly config: OpenRouterProviderConfig,
    state: OpenRouterProviderState,
    private readonly logger: GatewayLogger,
    onStateChanged: () => void,
    persistAccount?: (accountId: string, updates: Partial<OpenRouterAccountConfig>) => Promise<void>
  ) {
    this.pool = new OpenRouterAccountPool(config, state, logger, onStateChanged, persistAccount)
  }

  async initialize(accountFiles: OpenRouterAccountConfig[]): Promise<void> {
    await this.pool.reload(accountFiles)
  }

  async dispose(): Promise<void> {
    await this.pool.dispose()
  }

  async listModels(): Promise<ProviderModel[]> {
    return (await this.pool.listModelsFresh()).map((id) => ({
      id,
      provider: 'openrouter',
      ownedBy: 'openrouter'
    }))
  }

  async chatCompletions(body: any, context: GatewayRequestContext): Promise<GatewayResponse> {
    const model = String(body.model || '')
    const stream = body.stream === true
    if (stream) {
      return {
        status: 200,
        headers: sseHeaders(),
        stream: this.streamProxy(model, body, context)
      }
    }
    return this.nonStreamProxy(model, body, context)
  }

  async messages(_body: any, _context: GatewayRequestContext): Promise<GatewayResponse> {
    return jsonResponse(400, {
      error: {
        message:
          'OpenRouter does not support the Anthropic /messages API. Use OpenAI chat completions format.',
        type: 'invalid_request_error'
      }
    })
  }

  async testAccount(accountId: string): Promise<AccountTestResult> {
    return this.pool.testAccount(accountId)
  }

  async getAccountInfo(accountId: string): Promise<any> {
    return this.pool.getAccountInfo(accountId)
  }

  async refreshAccountModels(accountId: string): Promise<{ models: string[] }> {
    return this.pool.refreshAccountModelsById(accountId)
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
      label: account.config.label,
      enabled: account.config.enabled !== false,
      failures: account.state.failures,
      lastError: account.state.lastError,
      lastSuccessAt: account.state.lastSuccessAt,
      lastFailureAt: account.state.lastFailureAt,
      models: account.state.modelIds,
      stats: account.state.stats,
      authType: 'openrouter-api-key',
      status: account.state.status,
      statusReason: account.state.statusReason,
      statusUpdatedAt: account.state.statusUpdatedAt,
      cooldownUntil: account.state.cooldownUntil,
      lastResponseKind: account.state.lastResponseKind,
      keyLabel: account.config.keyLabel,
      isFreeTier: account.config.isFreeTier,
      limitRemaining: account.config.limitRemaining
    }))
    return {
      name: 'openrouter',
      providerType: 'openrouter',
      enabled: this.config.enabled,
      configured: accounts.length > 0,
      status: !this.config.enabled ? 'disabled' : accounts.length ? 'ready' : 'error',
      message: accounts.length ? `${accounts.length} key(s)` : 'No OpenRouter keys configured',
      models: this.pool.listModels(),
      accounts
    }
  }

  private async nonStreamProxy(
    model: string,
    body: any,
    context: GatewayRequestContext
  ): Promise<GatewayResponse> {
    const excluded = new Set<string>()
    let lastError: unknown
    const total = this.pool.listAccounts().length
    const attempts = Math.max(1, Math.min(total, this.config.settings.maxRetries + 1))
    for (let attempt = 0; attempt < attempts; attempt++) {
      const account = await this.pool.getAccountForModel(model, excluded)
      if (!account) break
      const startedAt = Date.now()
      try {
        const res = await this.fetchUpstream(account, body, false)
        const responseBody = await res.text()
        if (!res.ok) {
          const classified = classifyOpenRouterError(res.status, responseBody)
          throw Object.assign(new Error(`HTTP ${res.status}: ${responseBody.slice(0, 500)}`), {
            classified
          })
        }
        const parsed = parseJsonResponse(responseBody)
        this.reportUsage(parsed, model, account, context)
        await this.pool.reportSuccess(account)
        this.logger.info('OpenRouter upstream success', {
          ...UPSTREAM_META,
          requestId: context.requestId,
          accountId: account.config.label || account.config.id,
          model,
          duration: Date.now() - startedAt
        })
        return jsonResponse(200, parsed)
      } catch (error: any) {
        lastError = error
        const classified = error.classified ?? classifyOpenRouterError(0, toErrorMessage(error))
        await this.pool.reportFailure(account, error, classified)
        excluded.add(account.config.id)
        this.logger.warn(`OpenRouter upstream failed: ${toErrorMessage(error)}`, {
          ...UPSTREAM_META,
          requestId: context.requestId,
          accountId: account.config.label || account.config.id,
          model,
          duration: Date.now() - startedAt,
          extra: { kind: classified.kind, attempt: attempt + 1 }
        })
        if (classified.kind === 'auth' || classified.kind === 'quota') break
        await sleep(300 * Math.pow(2, attempt))
      }
    }
    const msg = toErrorMessage(lastError ?? 'No available OpenRouter accounts')
    return jsonResponse(502, { error: { message: msg, type: 'gateway_error' } })
  }

  private async *streamProxy(
    model: string,
    body: any,
    context: GatewayRequestContext
  ): AsyncGenerator<string> {
    const excluded = new Set<string>()
    let lastError: unknown
    const total = this.pool.listAccounts().length
    const attempts = Math.max(1, Math.min(total, this.config.settings.maxRetries + 1))
    for (let attempt = 0; attempt < attempts; attempt++) {
      const account = await this.pool.getAccountForModel(model, excluded)
      if (!account) break
      const startedAt = Date.now()
      try {
        const res = await this.fetchUpstream(account, body, true)
        if (!res.ok) {
          const errBody = await res.text().catch(() => '')
          const classified = classifyOpenRouterError(res.status, errBody)
          throw Object.assign(new Error(`HTTP ${res.status}: ${errBody.slice(0, 500)}`), {
            classified
          })
        }
        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        let usageChunk: any = null
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const text = decoder.decode(value, { stream: true })
          yield text
          const lines = text.split('\n')
          for (const line of lines) {
            if (line.startsWith('data: ') && line.includes('"usage"')) {
              try {
                const parsed = JSON.parse(line.slice(6))
                if (parsed.usage) usageChunk = parsed
              } catch {
                /* ignore parse errors in stream */
              }
            }
          }
        }
        if (usageChunk) this.reportUsage(usageChunk, model, account, context)
        await this.pool.reportSuccess(account)
        this.logger.info('OpenRouter stream success', {
          ...UPSTREAM_META,
          requestId: context.requestId,
          accountId: account.config.label || account.config.id,
          model,
          duration: Date.now() - startedAt
        })
        return
      } catch (error: any) {
        lastError = error
        const classified = error.classified ?? classifyOpenRouterError(0, toErrorMessage(error))
        await this.pool.reportFailure(account, error, classified)
        excluded.add(account.config.id)
        this.logger.warn(`OpenRouter stream failed: ${toErrorMessage(error)}`, {
          ...UPSTREAM_META,
          requestId: context.requestId,
          accountId: account.config.label || account.config.id,
          model,
          duration: Date.now() - startedAt,
          extra: { kind: classified.kind, attempt: attempt + 1 }
        })
        if (classified.kind === 'auth' || classified.kind === 'quota') break
        await sleep(300 * Math.pow(2, attempt))
      }
    }
    const message = `OpenRouter stream failed: ${toErrorMessage(lastError ?? 'No available accounts')}`
    yield sseData({ error: { message, type: 'gateway_error', code: 'openrouter_error' } })
    yield 'data: [DONE]\n\n'
  }

  private async fetchUpstream(
    account: OpenRouterAccountRuntime,
    body: any,
    stream: boolean
  ): Promise<Response> {
    const baseUrl = this.config.settings.baseUrl || OPENROUTER_BASE_URL
    const url = joinUrl(baseUrl, OPENROUTER_CHAT_COMPLETIONS_PATH)
    const timeout = stream
      ? this.config.settings.streamingReadTimeoutSeconds * 1000
      : this.config.settings.firstTokenTimeoutSeconds * 1000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${account.config.apiKey}`,
          'HTTP-Referer': 'https://gatewayhub.local',
          'X-Title': 'GatewayHub'
        },
        body: JSON.stringify({ ...body, stream }),
        signal: controller.signal
      })
    } finally {
      clearTimeout(timer)
    }
  }

  private reportUsage(
    parsed: any,
    model: string,
    account: OpenRouterAccountRuntime,
    context: GatewayRequestContext
  ): void {
    if (!context.onUsage || !parsed?.usage) return
    const u = parsed.usage
    const usage: UsageStats = {
      inputTokens: u.prompt_tokens || 0,
      outputTokens: u.completion_tokens || 0
    }
    context.onUsage(usage, {
      accountId: account.config.id,
      model,
      provider: 'openrouter'
    })
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function parseJsonResponse(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

function sseHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  }
}
