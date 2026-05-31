import type {
  AccountStatus,
  AccountTestResult,
  GatewayRequestContext,
  GatewayResponse,
  ProviderAdapter,
  ProviderModel,
  ProviderStatus,
  TraeAccountConfig,
  TraeProviderConfig,
  TraeProviderState,
  UsageMeta,
  UsageStats
} from '../../types'
import { GatewayLogger } from '../../core/logger'
import { jsonResponse, sleep, sseData, toErrorMessage } from '../../core/utils'
import { DEFAULT_TRAE_MODEL, describeTraeModel, normalizeTraeModel } from './constants'
import { TraeAccountPool, type TraeAccountRuntime, classifyTraeError } from './accountPool'
import { buildTraeRawChatPayload } from './converters'
import { runTraeLocalChat } from './localBridge'
import { runTraeRawChat } from './rawChat'
import {
  anthropicJsonFromText,
  anthropicSseFromText,
  openAiJsonFromText,
  openAiSseFromText
} from './streaming'

const UPSTREAM_META = { category: 'upstream' as const, provider: 'trae' as const }

export class TraeProvider implements ProviderAdapter {
  readonly name = 'trae'
  private readonly pool: TraeAccountPool

  constructor(
    private readonly config: TraeProviderConfig,
    state: TraeProviderState,
    private readonly logger: GatewayLogger,
    onStateChanged: () => void,
    persistAccount?: (accountId: string, updates: Partial<TraeAccountConfig>) => Promise<void>
  ) {
    this.pool = new TraeAccountPool(config, state, logger, onStateChanged, persistAccount)
  }

  async initialize(accountFiles: TraeAccountConfig[]): Promise<void> {
    await this.pool.reload(accountFiles)
  }

  async listModels(): Promise<ProviderModel[]> {
    return (await this.pool.listModelsFresh()).map((id) => {
      const detail = describeTraeModel(id)
      return {
        id,
        provider: 'trae',
        ownedBy: 'trae',
        description: detail
          ? `Trae built-in ${detail.displayName}${detail.unavailableInUS ? ' (not available in US)' : ''}`
          : 'Model via Trae provider'
      }
    })
  }

  async chatCompletions(body: any, context: GatewayRequestContext): Promise<GatewayResponse> {
    const model = normalizeTraeModel(String(body.model || DEFAULT_TRAE_MODEL))
    const stream = body.stream === true
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
    const model = normalizeTraeModel(String(body.model || DEFAULT_TRAE_MODEL))
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

  async countTokens(body: any): Promise<GatewayResponse> {
    return jsonResponse(200, {
      input_tokens: Math.max(1, Math.ceil(JSON.stringify(body).length / 4))
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
      label: account.config.label || account.config.email,
      email: account.config.email,
      enabled: account.config.enabled !== false,
      failures: account.state.failures,
      lastError: account.state.lastError,
      lastSuccessAt: account.state.lastSuccessAt,
      lastFailureAt: account.state.lastFailureAt,
      models: account.state.modelIds,
      stats: account.state.stats,
      authType: account.config.authType || 'trae-token',
      expiresAt: account.config.tokenExpiresAt
        ? new Date(account.config.tokenExpiresAt).toISOString()
        : undefined,
      status: account.state.status,
      statusReason: account.state.statusReason,
      statusUpdatedAt: account.state.statusUpdatedAt,
      cooldownUntil: account.state.cooldownUntil,
      lastResponseKind: account.state.lastResponseKind,
      countryCode: account.config.countryCode
    }))
    return {
      name: 'trae',
      providerType: 'trae',
      enabled: this.config.enabled,
      configured: accounts.length > 0,
      status: !this.config.enabled ? 'disabled' : accounts.length ? 'ready' : 'error',
      message: accounts.length ? `${accounts.length} account(s)` : 'No Trae accounts configured',
      models: this.pool.listModels(),
      accounts
    }
  }

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
        ? (u: UsageStats) => onUsage(u, { accountId: account.config.id, model, provider: 'trae' })
        : undefined
      const startedAt = Date.now()
      try {
        const result = await this.callTrae(account, format, model, body)
        const response =
          format === 'openai'
            ? openAiJsonFromText(result.text, model, body, sink, result.usage, result.toolCalls)
            : anthropicJsonFromText(result.text, model, body, sink, result.usage, result.toolCalls)
        await this.pool.reportSuccess(account)
        this.logger.info('Trae upstream success', {
          ...UPSTREAM_META,
          requestId: rid,
          accountId: accountLabel(account),
          duration: Date.now() - startedAt
        })
        return response
      } catch (error) {
        lastError = error
        const classified = classifyTraeError(error)
        await this.pool.reportFailure(account, error, classified)
        excluded.add(account.config.id)
        this.logger.warn(`Trae upstream failed: ${toErrorMessage(error)}`, {
          ...UPSTREAM_META,
          requestId: rid,
          accountId: accountLabel(account),
          duration: Date.now() - startedAt,
          extra: { kind: classified.kind, attempt: attempt + 1 }
        })
        if (
          classified.kind !== 'timeout' &&
          classified.kind !== 'network' &&
          classified.kind !== 'server_error'
        )
          break
        await sleep(300 * Math.pow(2, attempt))
      }
    }
    throw new Error(`Trae request failed: ${toErrorMessage(lastError ?? 'No available accounts')}`)
  }

  private async *streamWithFailover(
    format: 'openai' | 'anthropic',
    model: string,
    body: any,
    rid: string,
    onUsage?: (u: UsageStats, meta?: UsageMeta) => void
  ): AsyncGenerator<string> {
    try {
      const result = await this.nonStreamWithFailover(
        format,
        model,
        { ...body, stream: false },
        rid,
        onUsage
      )
      if (format === 'openai') {
        const text = result?.choices?.[0]?.message?.content || ''
        const toolCalls = result?.choices?.[0]?.message?.tool_calls
          ?.map?.((item: any) => ({
            id: item.id,
            name: item.function?.name,
            input: item.function?.arguments
          }))
          ?.filter?.((item: any) => item.name)
        yield* openAiSseFromText(text, model, body, undefined, undefined, toolCalls)
      } else {
        const text = result?.content?.find?.((item: any) => item?.type === 'text')?.text || ''
        const toolCalls = result?.content
          ?.filter?.((item: any) => item?.type === 'tool_use')
          ?.map?.((item: any) => ({ id: item.id, name: item.name, input: item.input }))
          ?.filter?.((item: any) => item.name)
        yield* anthropicSseFromText(text, model, body, undefined, undefined, toolCalls)
      }
    } catch (error) {
      const message = `Trae stream failed: ${toErrorMessage(error)}`
      if (format === 'openai') {
        yield sseData({ error: { message, type: 'gateway_error', code: 'trae_error' } })
        yield 'data: [DONE]\n\n'
      } else {
        yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`
      }
    }
  }

  private async callTrae(
    account: TraeAccountRuntime,
    format: 'openai' | 'anthropic',
    model: string,
    body: any
  ) {
    if (!account.auth) throw new Error('Trae account auth not initialized')
    const token = await account.auth.getJwtToken()
    if (this.config.settings.localChatEnabled !== false) {
      return runTraeLocalChat({
        settings: this.config.settings,
        account: account.config,
        token,
        model,
        body,
        format
      })
    }
    const payload = buildTraeRawChatPayload(model, body, format)
    return runTraeRawChat({
      settings: this.config.settings,
      accountCoreBaseUrl: account.config.coreBaseUrl,
      token,
      payload
    })
  }
}

function sseHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  }
}

function accountLabel(account: TraeAccountRuntime): string {
  return account.config.email || account.config.label || account.config.id
}
