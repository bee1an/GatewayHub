import type {
  AccountStatus,
  AccountTestResult,
  GatewayRequestContext,
  GatewayResponse,
  ProviderAdapter,
  ProviderModel,
  ProviderStatus,
  UsageMeta,
  UsageStats,
  WindsurfAccountConfig,
  WindsurfProviderConfig,
  WindsurfProviderState
} from '../../types'
import { GatewayLogger } from '../../core/logger'
import { jsonResponse, sseData, sleep, toErrorMessage } from '../../core/utils'
import { DEFAULT_WINDSURF_MODEL, normalizeWindsurfModel } from './constants'
import {
  WindsurfAccountPool,
  type WindsurfAccountRuntime,
  classifyWindsurfError
} from './accountPool'
import { anthropicToWindsurfPrompt, openAiToWindsurfPrompt } from './converters'
import { runWindsurfCascade, type WindsurfPromptPayload } from './cascade'
import {
  anthropicJsonFromText,
  anthropicSseFromText,
  openAiJsonFromText,
  openAiSseFromText
} from './streaming'

const UPSTREAM_META = { category: 'upstream' as const, provider: 'windsurf' as const }

export class WindsurfProvider implements ProviderAdapter {
  readonly name = 'windsurf'
  private readonly pool: WindsurfAccountPool

  constructor(
    private readonly config: WindsurfProviderConfig,
    state: WindsurfProviderState,
    private readonly logger: GatewayLogger,
    onStateChanged: () => void
  ) {
    this.pool = new WindsurfAccountPool(config, state, logger, onStateChanged)
  }

  async initialize(accountFiles: WindsurfAccountConfig[]): Promise<void> {
    await this.pool.reload(accountFiles)
  }

  async dispose(): Promise<void> {
    await this.pool.dispose()
  }

  async listModels(): Promise<ProviderModel[]> {
    return (await this.pool.listModelsFresh()).map((id) => ({
      id,
      provider: 'windsurf',
      ownedBy: 'windsurf',
      description: 'Model via Windsurf provider'
    }))
  }

  async chatCompletions(body: any, context: GatewayRequestContext): Promise<GatewayResponse> {
    const model = normalizeWindsurfModel(String(body.model || DEFAULT_WINDSURF_MODEL))
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
    const model = normalizeWindsurfModel(String(body.model || DEFAULT_WINDSURF_MODEL))
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
      authType: account.config.authType || 'windsurf-api-key',
      status: account.state.status,
      statusReason: account.state.statusReason,
      statusUpdatedAt: account.state.statusUpdatedAt,
      cooldownUntil: account.state.cooldownUntil,
      lastResponseKind: account.state.lastResponseKind
    }))
    return {
      name: 'windsurf',
      providerType: 'windsurf',
      enabled: this.config.enabled,
      configured: accounts.length > 0,
      status: !this.config.enabled ? 'disabled' : accounts.length ? 'ready' : 'error',
      message: accounts.length
        ? `${accounts.length} account(s)`
        : 'No Windsurf accounts configured',
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
        ? (u: UsageStats) =>
            onUsage(u, { accountId: account.config.id, model, provider: 'windsurf' })
        : undefined
      const startedAt = Date.now()
      try {
        const payload = this.buildPrompt(format, body)
        const cascade = await runWindsurfCascade(
          account.client!,
          payload,
          model,
          this.config.settings
        )
        const result =
          format === 'openai'
            ? openAiJsonFromText(cascade.text, model, body, sink, cascade.usage)
            : anthropicJsonFromText(cascade.text, model, body, sink, cascade.usage)
        await this.pool.reportSuccess(account)
        this.logger.info('Windsurf upstream success', {
          ...UPSTREAM_META,
          requestId: rid,
          accountId: accountLabel(account),
          duration: Date.now() - startedAt
        })
        return result
      } catch (error) {
        lastError = error
        const classified = classifyWindsurfError(error)
        await this.pool.reportFailure(account, error, classified)
        excluded.add(account.config.id)
        this.logger.warn(`Windsurf upstream failed: ${toErrorMessage(error)}`, {
          ...UPSTREAM_META,
          requestId: rid,
          accountId: accountLabel(account),
          duration: Date.now() - startedAt,
          extra: { kind: classified.kind, attempt: attempt + 1 }
        })
        if (classified.kind !== 'timeout' && classified.kind !== 'network') break
        await sleep(300 * Math.pow(2, attempt))
      }
    }
    throw new Error(
      `Windsurf request failed: ${toErrorMessage(lastError ?? 'No available accounts')}`
    )
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
        ? (u: UsageStats) =>
            onUsage(u, { accountId: account.config.id, model, provider: 'windsurf' })
        : undefined
      const startedAt = Date.now()
      try {
        const result = await runWindsurfCascade(
          account.client!,
          this.buildPrompt(format, body),
          model,
          this.config.settings
        )
        if (format === 'openai') {
          yield* openAiSseFromText(result.text, model, body, sink, result.usage)
        } else {
          yield* anthropicSseFromText(result.text, model, body, sink, result.usage)
        }
        await this.pool.reportSuccess(account)
        this.logger.info('Windsurf stream success', {
          ...UPSTREAM_META,
          requestId: rid,
          accountId: accountLabel(account),
          duration: Date.now() - startedAt
        })
        return
      } catch (error) {
        lastError = error
        const classified = classifyWindsurfError(error)
        await this.pool.reportFailure(account, error, classified)
        excluded.add(account.config.id)
        this.logger.warn(`Windsurf stream failed: ${toErrorMessage(error)}`, {
          ...UPSTREAM_META,
          requestId: rid,
          accountId: accountLabel(account),
          duration: Date.now() - startedAt,
          extra: { kind: classified.kind, attempt: attempt + 1 }
        })
        // Cascade 在产出任何字节前已完整 await 完成，失败时切换账号重试是安全的，
        // 与 nonStreamWithFailover 保持一致：仅 timeout/network 继续重试，其余直接中断。
        if (classified.kind !== 'timeout' && classified.kind !== 'network') break
        await sleep(300 * Math.pow(2, attempt))
      }
    }

    const message = `Windsurf stream failed: ${toErrorMessage(lastError ?? 'No available accounts')}`
    if (format === 'openai') {
      yield sseData({ error: { message, type: 'gateway_error', code: 'windsurf_error' } })
      yield 'data: [DONE]\n\n'
    } else {
      yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`
    }
  }

  private buildPrompt(format: 'openai' | 'anthropic', body: any): WindsurfPromptPayload {
    return format === 'openai' ? openAiToWindsurfPrompt(body) : anthropicToWindsurfPrompt(body)
  }
}

function sseHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  }
}

function accountLabel(account: WindsurfAccountRuntime): string {
  return account.config.email || account.config.label || account.config.id
}
