import type {
  AccountStatus,
  AccountTestResult,
  GatewayRequestContext,
  GatewayResponse,
  ProviderAdapter,
  ProviderModel,
  ProviderStatus,
  QoderAccountConfig,
  QoderProviderConfig,
  QoderProviderState,
  UsageStats
} from '../../types'
import { GatewayLogger } from '../../core/logger'
import { estimateTokens, jsonResponse, sleep, sseData, toErrorMessage } from '../../core/utils'
import {
  anthropicMessagesToOpenAIChatCompletions,
  openAIChatCompletionSseToAnthropicMessageSse,
  openAIChatCompletionToAnthropicMessage
} from '../../core/protocolAdapters'
import { QODER_KNOWN_MODELS, normalizeQoderModel } from './constants'
import { QoderAccountPool, classifyQoderError, type QoderAccountRuntime } from './accountPool'
import {
  collectQoderChatCompletion,
  qoderAccountUsesDirectApi,
  qoderCompletionId,
  streamQoderChatCompletion,
  type QoderChatStreamEvent
} from './client'

const UPSTREAM_META = { category: 'upstream' as const, provider: 'qoder' as const }

export class QoderProvider implements ProviderAdapter {
  readonly name = 'qoder'
  private readonly pool: QoderAccountPool

  constructor(
    private readonly config: QoderProviderConfig,
    state: QoderProviderState,
    private readonly logger: GatewayLogger,
    onStateChanged: () => void
  ) {
    this.pool = new QoderAccountPool(config, state, logger, onStateChanged)
  }

  async initialize(accountFiles: QoderAccountConfig[]): Promise<void> {
    await this.pool.reload(accountFiles)
  }

  dispose(): void {
    this.pool.dispose()
  }

  async listModels(): Promise<ProviderModel[]> {
    const descriptions = new Map(QODER_KNOWN_MODELS.map((model) => [model.id, model.description]))
    return (await this.pool.listModelsFresh()).map((id) => ({
      id,
      provider: 'qoder',
      ownedBy: 'qoder',
      description: descriptions.get(id) || 'Qoder direct API model'
    }))
  }

  async chatCompletions(body: any, context: GatewayRequestContext): Promise<GatewayResponse> {
    const model = normalizeQoderModel(String(body.model || 'auto'))
    if (!this.pool.hasDirectAccounts()) return noQoderCredentialResponse()
    const stream = body.stream === true
    if (stream) {
      return {
        status: 200,
        headers: sseHeaders(),
        stream: this.streamWithFailover(model, body, context)
      }
    }
    return this.nonStreamWithFailover(model, body, context)
  }

  async messages(body: any, context: GatewayRequestContext): Promise<GatewayResponse> {
    const model = normalizeQoderModel(String(body.model || 'auto'))
    if (!this.pool.hasDirectAccounts()) return noQoderCredentialResponse()
    const openAiBody = anthropicMessagesToOpenAIChatCompletions(body, model)
    if (body.stream === true) {
      return {
        status: 200,
        headers: sseHeaders(),
        stream: openAIChatCompletionSseToAnthropicMessageSse(
          this.streamWithFailover(model, openAiBody, context),
          model
        )
      }
    }
    const response = await this.nonStreamWithFailover(model, openAiBody, context)
    if (response.status >= 400) return response
    return jsonResponse(
      response.status,
      openAIChatCompletionToAnthropicMessage(response.body, model, body)
    )
  }

  async countTokens(body: any): Promise<GatewayResponse> {
    return jsonResponse(200, {
      input_tokens: Math.max(1, Math.ceil(JSON.stringify(body ?? {}).length / 4))
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
    const runtimes = this.pool.listAccounts()
    const directCount = runtimes.filter((account) =>
      qoderAccountUsesDirectApi(account.config)
    ).length
    const accounts = runtimes.map((account) => ({
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
      authType: account.config.personalAccessToken
        ? 'qoder-personal-access-token'
        : 'qoder-cli-auth',
      directApi: qoderAccountUsesDirectApi(account.config),
      status: account.state.status,
      statusReason: account.state.statusReason,
      statusUpdatedAt: account.state.statusUpdatedAt,
      cooldownUntil: account.state.cooldownUntil,
      lastResponseKind: account.state.lastResponseKind
    }))
    return {
      name: 'qoder',
      providerType: 'qoder',
      enabled: this.config.enabled,
      configured: directCount > 0,
      status: !this.config.enabled ? 'disabled' : directCount ? 'ready' : 'error',
      message: directCount
        ? `${directCount} direct credential account(s)`
        : 'No Qoder direct credentials configured',
      models: this.pool.listModels(),
      accounts
    }
  }

  private async nonStreamWithFailover(
    model: string,
    body: any,
    context: GatewayRequestContext
  ): Promise<GatewayResponse> {
    const excluded = new Set<string>()
    let lastError: unknown
    const total = this.pool.listAccounts().length
    const attempts = Math.max(1, Math.min(total, this.config.settings.maxRetries + 1))
    for (let attempt = 0; attempt < attempts; attempt++) {
      const account = this.pool.getAccount(model, excluded)
      if (!account) break
      const startedAt = Date.now()
      try {
        const result = await collectQoderChatCompletion({
          account: account.config,
          settings: this.config.settings,
          body,
          model,
          context
        })
        await this.pool.reportSuccess(account)
        this.reportUsage(body, result.text, model, account, context, result.usage)
        this.logger.info('Qoder upstream success', {
          ...UPSTREAM_META,
          requestId: context.requestId,
          accountId: account.config.email || account.config.label || account.config.id,
          model,
          duration: Date.now() - startedAt
        })
        return jsonResponse(200, result.completion)
      } catch (error) {
        if (context.abortSignal?.aborted) {
          return jsonResponse(499, {
            error: { message: 'Client aborted request', type: 'client_aborted' }
          })
        }
        lastError = error
        const classified = classifyQoderError(error)
        await this.pool.reportFailure(account, error, classified)
        excluded.add(account.config.id)
        this.logger.warn(`Qoder upstream failed: ${toErrorMessage(error)}`, {
          ...UPSTREAM_META,
          requestId: context.requestId,
          accountId: account.config.email || account.config.label || account.config.id,
          model,
          duration: Date.now() - startedAt,
          extra: { kind: classified.kind, attempt: attempt + 1 }
        })
        await sleep(300 * Math.pow(2, attempt))
      }
    }
    const msg = toErrorMessage(lastError ?? 'No available Qoder direct credential accounts')
    return jsonResponse(502, { error: { message: msg, type: 'gateway_error' } })
  }

  private async *streamWithFailover(
    model: string,
    body: any,
    context: GatewayRequestContext
  ): AsyncGenerator<string | Uint8Array> {
    const excluded = new Set<string>()
    let lastError: unknown
    const total = this.pool.listAccounts().length
    const attempts = Math.max(1, Math.min(total, this.config.settings.maxRetries + 1))
    for (let attempt = 0; attempt < attempts; attempt++) {
      const account = this.pool.getAccount(model, excluded)
      if (!account) break
      const startedAt = Date.now()
      const id = qoderCompletionId()
      let emitted = false
      let fullText = ''
      let finishReason = 'stop'
      let usage: QoderChatStreamEvent['usage']
      let sawTerminalChunk = false
      try {
        for await (const event of streamQoderChatCompletion({
          account: account.config,
          settings: this.config.settings,
          body,
          model,
          context
        })) {
          if (event.done) break
          if (event.usage) usage = event.usage
          if (event.finishReason) finishReason = normalizeFinishReason(event.finishReason)
          if (event.text) fullText += event.text
          if (!event.raw) continue
          const chunk = normalizeOpenAIChunk(event.raw, id, model)
          if (chunkHasFinishReason(chunk)) sawTerminalChunk = true
          emitted = true
          yield sseData(chunk)
        }

        if (!sawTerminalChunk) {
          yield sseData({
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
          })
        }
        yield 'data: [DONE]\n\n'
        await this.pool.reportSuccess(account)
        this.reportUsage(body, fullText, model, account, context, usage)
        this.logger.info('Qoder upstream success (stream)', {
          ...UPSTREAM_META,
          requestId: context.requestId,
          accountId: account.config.email || account.config.label || account.config.id,
          model,
          duration: Date.now() - startedAt
        })
        return
      } catch (error) {
        if (context.abortSignal?.aborted) return
        lastError = error
        const classified = classifyQoderError(error)
        await this.pool.reportFailure(account, error, classified)
        excluded.add(account.config.id)
        this.logger.warn(`Qoder stream failed: ${toErrorMessage(error)}`, {
          ...UPSTREAM_META,
          requestId: context.requestId,
          accountId: account.config.email || account.config.label || account.config.id,
          model,
          duration: Date.now() - startedAt,
          extra: { kind: classified.kind, attempt: attempt + 1, emitted }
        })
        if (emitted) break
        await sleep(300 * Math.pow(2, attempt))
      }
    }
    const msg = toErrorMessage(lastError ?? 'No available Qoder direct credential accounts')
    yield sseData({ error: { message: msg, type: 'server_error' } })
  }

  private reportUsage(
    body: any,
    output: string,
    model: string,
    account: QoderAccountRuntime,
    context: GatewayRequestContext,
    upstreamUsage?: QoderChatStreamEvent['usage']
  ): void {
    const usage: UsageStats = {
      inputTokens: numeric(upstreamUsage?.prompt_tokens) ?? estimateTokens(body?.messages ?? body),
      outputTokens:
        numeric(upstreamUsage?.completion_tokens) ?? Math.max(0, Math.ceil(output.length / 4)),
      estimated: !upstreamUsage
    }
    context.onUsage?.(usage, { accountId: account.config.id, model, provider: 'qoder' })
  }
}

function normalizeFinishReason(value: string): string {
  if (value === 'tool_calls' || value === 'length' || value === 'content_filter') return value
  return 'stop'
}

function normalizeOpenAIChunk(raw: any, id: string, model: string): any {
  return {
    id: raw?.id || id,
    object: raw?.object || 'chat.completion.chunk',
    created: raw?.created || Math.floor(Date.now() / 1000),
    model: raw?.model || model,
    ...raw,
    choices: Array.isArray(raw?.choices) ? raw.choices : []
  }
}

function chunkHasFinishReason(chunk: any): boolean {
  return Boolean(chunk?.choices?.some((choice: any) => choice?.finish_reason))
}

function numeric(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function sseHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  }
}

function noQoderCredentialResponse(): GatewayResponse {
  return jsonResponse(502, {
    error: {
      message:
        'No available Qoder direct credentials. Add a Personal Access Token or import a qodercli auth bundle.',
      type: 'gateway_error'
    }
  })
}
