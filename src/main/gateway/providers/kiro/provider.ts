import type {
  AccountTestResult,
  GatewayRequestContext,
  GatewayResponse,
  KiroAccountConfig,
  KiroProviderConfig,
  KiroProviderState,
  ProviderAdapter,
  ProviderModel,
  ProviderStatus
} from '../../types'
import { GatewayLogger } from '../../core/logger'
import { estimateTokens, jsonResponse, sseData, sleep, toErrorMessage } from '../../core/utils'
import { kiroFetch } from './auth'
import { KiroAccountPool, KiroAccountRuntime, toKiroModelId } from './accountPool'
import { buildKiroPayloadFromAnthropic, buildKiroPayloadFromOpenAI } from './converters'
import type { AccountInfo } from './types'
import {
  FirstTokenTimeoutError,
  anthropicJsonFromKiro,
  anthropicSseFromKiro,
  openAiJsonFromKiro,
  openAiSseFromKiro
} from './streaming'

export class KiroProvider implements ProviderAdapter {
  readonly name = 'kiro'
  private readonly pool: KiroAccountPool

  constructor(
    private readonly config: KiroProviderConfig,
    state: KiroProviderState,
    logger: GatewayLogger,
    onStateChanged: () => void
  ) {
    this.pool = new KiroAccountPool(config, state, logger, onStateChanged)
  }

  async initialize(accountFiles: KiroAccountConfig[]): Promise<void> {
    await this.pool.reload(accountFiles)
  }

  async listModels(): Promise<ProviderModel[]> {
    return this.pool.listModels().map((id) => ({ id, provider: 'kiro', ownedBy: 'kiro', description: 'Model via Kiro GatewayHub provider' }))
  }

  async chatCompletions(body: any, _context: GatewayRequestContext): Promise<GatewayResponse> {
    const model = body.model || 'claude-sonnet-4.5'
    const kiroModel = toKiroModelId(model)
    const stream = body.stream !== false

    if (stream) {
      return {
        status: 200,
        headers: sseHeaders(),
        stream: this.streamWithFailover('openai', model, kiroModel, body)
      }
    }

    const result = await this.nonStreamWithFailover('openai', model, kiroModel, body)
    return jsonResponse(200, result)
  }

  async messages(body: any, _context: GatewayRequestContext): Promise<GatewayResponse> {
    const model = body.model || 'claude-sonnet-4.5'
    const kiroModel = toKiroModelId(model)
    const stream = body.stream === true

    if (stream) {
      return {
        status: 200,
        headers: sseHeaders(),
        stream: this.streamWithFailover('anthropic', model, kiroModel, body)
      }
    }

    const result = await this.nonStreamWithFailover('anthropic', model, kiroModel, body)
    return jsonResponse(200, result)
  }

  async countTokens(body: any): Promise<GatewayResponse> {
    return jsonResponse(200, { input_tokens: estimateTokens({ messages: body.messages, system: body.system, tools: body.tools }) })
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
      expiresAt: account.auth?.expiresAtIso
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

  private async nonStreamWithFailover(format: 'openai' | 'anthropic', model: string, kiroModel: string, body: any): Promise<any> {
    const excluded = new Set<string>()
    let lastError: unknown
    for (let attempt = 0; attempt < Math.max(1, this.pool.listAccounts().length); attempt++) {
      const account = await this.pool.getAccountForModel(kiroModel, excluded)
      if (!account) break
      try {
        const payload = this.buildPayload(format, body, model, account)
        const response = await this.callKiro(account, payload)
        if (!response.body) throw new Error('Kiro response body is empty')
        const result =
          format === 'openai'
            ? await openAiJsonFromKiro(response.body, model, body, this.config.settings.firstTokenTimeoutSeconds)
            : await anthropicJsonFromKiro(response.body, model, this.config.settings.firstTokenTimeoutSeconds)
        await this.pool.reportSuccess(account)
        return result
      } catch (error) {
        lastError = error
        await this.pool.reportFailure(account, error)
        excluded.add(account.config.id)
      }
    }
    throw new Error(`Kiro request failed: ${toErrorMessage(lastError ?? 'No available accounts')}`)
  }

  private async *streamWithFailover(format: 'openai' | 'anthropic', model: string, kiroModel: string, body: any): AsyncGenerator<string> {
    const excluded = new Set<string>()
    let lastError: unknown
    for (let attempt = 0; attempt < Math.max(1, this.pool.listAccounts().length); attempt++) {
      const account = await this.pool.getAccountForModel(kiroModel, excluded)
      if (!account) break
      try {
        const payload = this.buildPayload(format, body, model, account)
        const response = await this.callKiro(account, payload)
        if (!response.body) throw new Error('Kiro response body is empty')
        if (format === 'openai') yield* openAiSseFromKiro(response.body, model, body, this.config.settings.firstTokenTimeoutSeconds)
        else yield* anthropicSseFromKiro(response.body, model, this.config.settings.firstTokenTimeoutSeconds)
        await this.pool.reportSuccess(account)
        return
      } catch (error) {
        lastError = error
        await this.pool.reportFailure(account, error)
        excluded.add(account.config.id)
        if (!(error instanceof FirstTokenTimeoutError)) break
      }
    }

    const message = `Kiro stream failed: ${toErrorMessage(lastError ?? 'No available accounts')}`
    if (format === 'openai') {
      yield sseData({ error: { message, type: 'gateway_error', code: 'kiro_error' } })
      yield 'data: [DONE]\n\n'
    } else {
      yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`
    }
  }

  private buildPayload(format: 'openai' | 'anthropic', body: any, model: string, account: KiroAccountRuntime): any {
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
        lastError = new Error(`Kiro HTTP ${response.status}: ${text.slice(0, 1000)}`)
        if (response.status === 429 || response.status >= 500) {
          await sleep(500 * Math.pow(2, attempt))
          continue
        }
        throw lastError
      } catch (error) {
        lastError = error
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
