import { randomUUID } from 'crypto'
import type {
  AccountStatus,
  AccountTestResult,
  GatewayRequestContext,
  GatewayResponse,
  GrokWebAccountConfig,
  GrokWebProviderConfig,
  GrokWebProviderState,
  ProviderAdapter,
  ProviderModel,
  ProviderStatus,
  UsageMeta,
  UsageStats
} from '../../types'
import { GatewayLogger } from '../../core/logger'
import { jsonResponse, sleep, sseData, toErrorMessage } from '../../core/utils'
import {
  anthropicMessagesToOpenAIChatCompletions,
  openAIChatCompletionSseToAnthropicMessageSse,
  openAIChatCompletionToAnthropicMessage
} from '../../core/protocolAdapters'
import { normalizeGrokWebModel } from './constants'
import { classifyGrokWebError, GrokWebAccountPool, type GrokWebAccountRuntime } from './accountPool'
import { streamGrokConversation } from './http'
import { convertOpenAIToGrokPrompt, createStreamingState, parseGrokGatewayEvent } from './streaming'

const UPSTREAM_META = { category: 'upstream' as const, provider: 'grokWeb' as const }

export class GrokWebProvider implements ProviderAdapter {
  readonly name = 'grokWeb'
  private readonly pool: GrokWebAccountPool

  constructor(
    private readonly config: GrokWebProviderConfig,
    state: GrokWebProviderState,
    private readonly logger: GatewayLogger,
    onStateChanged: () => void
  ) {
    this.pool = new GrokWebAccountPool(config, state, logger, onStateChanged)
  }

  async initialize(accountFiles: GrokWebAccountConfig[]): Promise<void> {
    await this.pool.reload(accountFiles)
  }

  dispose(): void {
    this.pool.dispose()
  }

  async listModels(): Promise<ProviderModel[]> {
    return (await this.pool.listModelsFresh()).map((id) => ({
      id,
      provider: 'grokWeb',
      ownedBy: 'x.ai',
      description: 'Model via Grok Web'
    }))
  }

  async chatCompletions(body: any, context: GatewayRequestContext): Promise<GatewayResponse> {
    const model = normalizeGrokWebModel(String(body.model || 'auto'))
    const stream = body.stream !== false
    if (stream) {
      return {
        status: 200,
        headers: sseHeaders(),
        stream: this.streamWithFailover(model, body, context.requestId, context.onUsage)
      }
    }
    const result = await this.nonStreamWithFailover(model, body, context.requestId, context.onUsage)
    return jsonResponse(200, result)
  }

  async messages(body: any, context: GatewayRequestContext): Promise<GatewayResponse> {
    const model = normalizeGrokWebModel(String(body.model || 'auto'))
    const openAiBody = anthropicMessagesToOpenAIChatCompletions(body, model)
    const stream = body.stream === true
    if (stream) {
      return {
        status: 200,
        headers: sseHeaders(),
        stream: openAIChatCompletionSseToAnthropicMessageSse(
          this.streamWithFailover(model, openAiBody, context.requestId, context.onUsage),
          model
        )
      }
    }
    const result = await this.nonStreamWithFailover(
      model,
      openAiBody,
      context.requestId,
      context.onUsage
    )
    return jsonResponse(200, openAIChatCompletionToAnthropicMessage(result, model, body))
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
      planType: account.config.planType,
      status: account.state.status,
      statusReason: account.state.statusReason,
      statusUpdatedAt: account.state.statusUpdatedAt,
      cooldownUntil: account.state.cooldownUntil,
      lastResponseKind: account.state.lastResponseKind
    }))
    return {
      name: 'grokWeb',
      providerType: 'grokWeb',
      enabled: this.config.enabled,
      configured: accounts.length > 0,
      status: !this.config.enabled ? 'disabled' : accounts.length ? 'ready' : 'error',
      message: accounts.length
        ? `${accounts.length} account(s)`
        : 'No Grok Web accounts configured',
      models: this.pool.listModels(),
      accounts
    }
  }

  private async nonStreamWithFailover(
    model: string,
    body: any,
    rid: string,
    onUsage?: (u: UsageStats, meta?: UsageMeta) => void
  ): Promise<any> {
    const excluded = new Set<string>()
    let lastError: unknown
    const total = this.pool.listAccounts().length
    for (let attempt = 0; attempt < Math.max(1, total); attempt++) {
      const account = this.pool.getAccount(excluded)
      if (!account) break
      const startedAt = Date.now()
      try {
        const text = await this.doRequest(account, model, body)
        await this.pool.reportSuccess(account)
        this.logger.info('Grok Web upstream success', {
          ...UPSTREAM_META,
          requestId: rid,
          accountId: account.config.email || account.config.id,
          duration: Date.now() - startedAt
        })
        if (onUsage) {
          onUsage(
            { inputTokens: 0, outputTokens: Math.ceil(text.length / 4), estimated: true },
            { accountId: account.config.id, model, provider: 'grokWeb' }
          )
        }
        return buildNonStreamResponse(text, model)
      } catch (error) {
        lastError = error
        const classified = classifyGrokWebError(error)
        await this.pool.reportFailure(account, error, classified)
        excluded.add(account.config.id)
        this.logger.warn(`Grok Web upstream failed: ${toErrorMessage(error)}`, {
          ...UPSTREAM_META,
          requestId: rid,
          accountId: account.config.email || account.config.id,
          duration: Date.now() - startedAt,
          extra: { kind: classified.kind, attempt: attempt + 1 }
        })
        if (classified.kind !== 'timeout' && classified.kind !== 'network') break
        await sleep(300 * Math.pow(2, attempt))
      }
    }
    throw new Error(
      `Grok Web request failed: ${toErrorMessage(lastError ?? 'No available accounts')}`
    )
  }

  private async *streamWithFailover(
    model: string,
    body: any,
    rid: string,
    onUsage?: (u: UsageStats, meta?: UsageMeta) => void
  ): AsyncGenerator<string | Uint8Array> {
    const excluded = new Set<string>()
    let lastError: unknown
    const total = this.pool.listAccounts().length
    for (let attempt = 0; attempt < Math.max(1, total); attempt++) {
      const account = this.pool.getAccount(excluded)
      if (!account) break
      const startedAt = Date.now()
      try {
        const state = createStreamingState(model)
        const ctx = this.pool.buildRequestContext(account)
        const prompt = convertOpenAIToGrokPrompt(body.messages || [])
        for await (const event of streamGrokConversation(ctx, { model, prompt })) {
          const { chunk, done } = parseGrokGatewayEvent(event, state)
          if (chunk) yield chunk
          if (done) break
        }
        yield 'data: [DONE]\n\n'
        await this.pool.reportSuccess(account)
        this.logger.info('Grok Web upstream success (stream)', {
          ...UPSTREAM_META,
          requestId: rid,
          accountId: account.config.email || account.config.id,
          duration: Date.now() - startedAt
        })
        if (onUsage) {
          onUsage(
            { inputTokens: 0, outputTokens: Math.ceil(state.content.length / 4), estimated: true },
            { accountId: account.config.id, model, provider: 'grokWeb' }
          )
        }
        return
      } catch (error) {
        lastError = error
        const classified = classifyGrokWebError(error)
        await this.pool.reportFailure(account, error, classified)
        excluded.add(account.config.id)
        this.logger.warn(`Grok Web stream failed: ${toErrorMessage(error)}`, {
          ...UPSTREAM_META,
          requestId: rid,
          accountId: account.config.email || account.config.id,
          duration: Date.now() - startedAt,
          extra: { kind: classified.kind, attempt: attempt + 1 }
        })
        if (classified.kind !== 'timeout' && classified.kind !== 'network') break
        await sleep(300 * Math.pow(2, attempt))
      }
    }
    yield sseData({
      error: { message: toErrorMessage(lastError ?? 'No available accounts'), type: 'server_error' }
    })
  }

  private async doRequest(
    account: GrokWebAccountRuntime,
    model: string,
    body: any
  ): Promise<string> {
    const state = createStreamingState(model)
    const ctx = this.pool.buildRequestContext(account)
    const prompt = convertOpenAIToGrokPrompt(body.messages || [])
    for await (const event of streamGrokConversation(ctx, { model, prompt })) {
      const { done } = parseGrokGatewayEvent(event, state)
      if (done) break
    }
    if (!state.content) throw new Error('Empty response from Grok Web')
    return state.content
  }
}

function sseHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  }
}

function buildNonStreamResponse(text: string, model: string): any {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop'
      }
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: Math.ceil(text.length / 4),
      total_tokens: Math.ceil(text.length / 4)
    }
  }
}
