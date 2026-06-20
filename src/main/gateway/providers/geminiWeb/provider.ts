import { randomUUID } from 'crypto'
import type {
  AccountStatus,
  AccountTestResult,
  GatewayRequestContext,
  GatewayResponse,
  GeminiWebAccountConfig,
  GeminiWebProviderConfig,
  GeminiWebProviderState,
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
import { normalizeGeminiWebModel } from './constants'
import {
  classifyGeminiWebError,
  GeminiWebAccountPool,
  type GeminiWebAccountRuntime
} from './accountPool'
import { streamGeminiConversation } from './http'
import {
  convertOpenAIToGeminiPrompt,
  createStreamingState,
  parseGeminiBatchEvent
} from './streaming'

const UPSTREAM_META = { category: 'upstream' as const, provider: 'geminiWeb' as const }

export class GeminiWebProvider implements ProviderAdapter {
  readonly name = 'geminiWeb'
  private readonly pool: GeminiWebAccountPool

  constructor(
    private readonly config: GeminiWebProviderConfig,
    state: GeminiWebProviderState,
    private readonly logger: GatewayLogger,
    onStateChanged: () => void,
    persistAccount?: (accountId: string, updates: Partial<GeminiWebAccountConfig>) => Promise<void>
  ) {
    this.pool = new GeminiWebAccountPool(config, state, logger, onStateChanged, persistAccount)
  }

  async initialize(accountFiles: GeminiWebAccountConfig[]): Promise<void> {
    await this.pool.reload(accountFiles)
  }

  dispose(): void {
    this.pool.dispose()
  }

  async listModels(): Promise<ProviderModel[]> {
    return (await this.pool.listModelsFresh()).map((id) => ({
      id,
      provider: 'geminiWeb',
      ownedBy: 'google',
      description: 'Model via Gemini Web'
    }))
  }

  async chatCompletions(body: any, context: GatewayRequestContext): Promise<GatewayResponse> {
    const model = normalizeGeminiWebModel(String(body.model || 'gemini-3.5-flash'))
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
    const model = normalizeGeminiWebModel(String(body.model || 'gemini-3.5-flash'))
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
      name: 'geminiWeb',
      providerType: 'geminiWeb',
      enabled: this.config.enabled,
      configured: accounts.length > 0,
      status: !this.config.enabled ? 'disabled' : accounts.length ? 'ready' : 'error',
      message: accounts.length
        ? `${accounts.length} account(s)`
        : 'No Gemini Web accounts configured',
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
        this.logger.info('Gemini Web upstream success', {
          ...UPSTREAM_META,
          requestId: rid,
          accountId: account.config.email || account.config.id,
          duration: Date.now() - startedAt
        })
        if (onUsage) {
          onUsage(
            { inputTokens: 0, outputTokens: Math.ceil(text.length / 4), estimated: true },
            { accountId: account.config.id, model, provider: 'geminiWeb' }
          )
        }
        return buildNonStreamResponse(text, model)
      } catch (error) {
        lastError = error
        const classified = classifyGeminiWebError(error)
        await this.pool.reportFailure(account, error, classified)
        excluded.add(account.config.id)
        this.logger.warn(`Gemini Web upstream failed: ${toErrorMessage(error)}`, {
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
      `Gemini Web request failed: ${toErrorMessage(lastError ?? 'No available accounts')}`
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
        const prompt = convertOpenAIToGeminiPrompt(body.messages || [])
        for await (const event of streamGeminiConversation(ctx, { model, prompt })) {
          const { chunk, done } = parseGeminiBatchEvent(event, state)
          if (chunk) yield chunk
          if (done) break
        }
        yield 'data: [DONE]\n\n'
        await this.pool.reportSuccess(account)
        this.logger.info('Gemini Web upstream success (stream)', {
          ...UPSTREAM_META,
          requestId: rid,
          accountId: account.config.email || account.config.id,
          duration: Date.now() - startedAt
        })
        if (onUsage) {
          onUsage(
            { inputTokens: 0, outputTokens: Math.ceil(state.content.length / 4), estimated: true },
            { accountId: account.config.id, model, provider: 'geminiWeb' }
          )
        }
        return
      } catch (error) {
        lastError = error
        const classified = classifyGeminiWebError(error)
        await this.pool.reportFailure(account, error, classified)
        excluded.add(account.config.id)
        this.logger.warn(`Gemini Web stream failed: ${toErrorMessage(error)}`, {
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
    account: GeminiWebAccountRuntime,
    model: string,
    body: any
  ): Promise<string> {
    const state = createStreamingState(model)
    const ctx = this.pool.buildRequestContext(account)
    const prompt = convertOpenAIToGeminiPrompt(body.messages || [])
    for await (const event of streamGeminiConversation(ctx, { model, prompt })) {
      const { done } = parseGeminiBatchEvent(event, state)
      if (done) break
    }
    if (!state.content) throw new Error('Empty response from Gemini Web')
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
