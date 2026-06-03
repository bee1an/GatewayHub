import type {
  AccountStatus,
  AccountTestResult,
  GptWebAccountConfig,
  GptWebProviderConfig,
  GptWebProviderState,
  GatewayRequestContext,
  GatewayResponse,
  ProviderAdapter,
  ProviderModel,
  ProviderStatus,
  UsageMeta,
  UsageStats
} from '../../types'
import { GatewayLogger } from '../../core/logger'
import { jsonResponse, sseData, sleep, toErrorMessage } from '../../core/utils'
import {
  anthropicMessagesToOpenAIChatCompletions,
  openAIChatCompletionSseToAnthropicMessageSse,
  openAIChatCompletionToAnthropicMessage
} from '../../core/protocolAdapters'
import { normalizeGptWebModel } from './constants'
import { GptWebAccountPool, classifyGptWebError, type GptWebAccountRuntime } from './accountPool'
import { convertOpenAIToGptWebBody, parseGptWebSSE, createStreamingState } from './streaming'
import { fetchSentinelTokens, fetchConduitToken, streamConversation } from './http'
import { disposeTurnstileBrowser } from './turnstile'
import { shouldUseNodeBridge, streamConversationViaNodeBridge } from './nodeBridge'

const UPSTREAM_META = { category: 'upstream' as const, provider: 'gptWeb' as const }

export class GptWebProvider implements ProviderAdapter {
  readonly name = 'gptWeb'
  private readonly pool: GptWebAccountPool

  constructor(
    private readonly config: GptWebProviderConfig,
    state: GptWebProviderState,
    private readonly logger: GatewayLogger,
    onStateChanged: () => void
  ) {
    this.pool = new GptWebAccountPool(config, state, logger, onStateChanged)
  }

  async initialize(accountFiles: GptWebAccountConfig[]): Promise<void> {
    await this.pool.reload(accountFiles)
  }

  dispose(): void {
    this.pool.dispose()
    disposeTurnstileBrowser()
  }

  async listModels(): Promise<ProviderModel[]> {
    return (await this.pool.listModelsFresh()).map((id) => ({
      id,
      provider: 'gptWeb',
      ownedBy: 'openai',
      description: 'Model via GptWeb'
    }))
  }

  async chatCompletions(body: any, context: GatewayRequestContext): Promise<GatewayResponse> {
    const model = normalizeGptWebModel(String(body.model || 'auto'))
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
    const model = normalizeGptWebModel(String(body.model || 'auto'))
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
      name: 'gptWeb',
      providerType: 'gptWeb',
      enabled: this.config.enabled,
      configured: accounts.length > 0,
      status: !this.config.enabled ? 'disabled' : accounts.length ? 'ready' : 'error',
      message: accounts.length ? `${accounts.length} account(s)` : 'No GptWeb accounts configured',
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
        this.pool.reportSuccess(account)
        this.logger.info('GptWeb upstream success', {
          ...UPSTREAM_META,
          requestId: rid,
          accountId: account.config.email || account.config.id,
          duration: Date.now() - startedAt
        })
        const result = buildNonStreamResponse(text, model)
        if (onUsage) {
          onUsage(
            { inputTokens: 0, outputTokens: Math.ceil(text.length / 4), estimated: true },
            { accountId: account.config.id, model, provider: 'gptWeb' }
          )
        }
        return result
      } catch (error) {
        lastError = error
        const classified = classifyGptWebError(error)
        this.pool.reportFailure(account, error, classified)
        excluded.add(account.config.id)
        this.logger.warn(`GptWeb upstream failed: ${toErrorMessage(error)}`, {
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
      `GptWeb request failed: ${toErrorMessage(lastError ?? 'No available accounts')}`
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
        const ctx = this.pool.buildRequestContext(account)
        const chatBody = convertOpenAIToGptWebBody(body.messages || [], model)
        const state = createStreamingState()
        const upstream = shouldUseNodeBridge()
          ? streamConversationViaNodeBridge(ctx, chatBody)
          : this.streamConversationDirect(ctx, chatBody)

        for await (const line of upstream) {
          const { chunk, done } = parseGptWebSSE(line, state)
          if (chunk) yield chunk
          if (done) break
        }

        yield 'data: [DONE]\n\n'
        this.pool.reportSuccess(account)
        this.logger.info('GptWeb upstream success (stream)', {
          ...UPSTREAM_META,
          requestId: rid,
          accountId: account.config.email || account.config.id,
          duration: Date.now() - startedAt
        })
        if (onUsage) {
          onUsage(
            { inputTokens: 0, outputTokens: Math.ceil(state.content.length / 4), estimated: true },
            { accountId: account.config.id, model, provider: 'gptWeb' }
          )
        }
        return
      } catch (error) {
        lastError = error
        const classified = classifyGptWebError(error)
        this.pool.reportFailure(account, error, classified)
        excluded.add(account.config.id)
        this.logger.warn(`GptWeb stream failed: ${toErrorMessage(error)}`, {
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
    const errMsg = toErrorMessage(lastError ?? 'No available accounts')
    yield sseData({ error: { message: errMsg, type: 'server_error' } })
  }

  private async doRequest(
    account: GptWebAccountRuntime,
    model: string,
    body: any
  ): Promise<string> {
    const ctx = this.pool.buildRequestContext(account)
    const chatBody = convertOpenAIToGptWebBody(body.messages || [], model)
    const state = createStreamingState()
    const upstream = shouldUseNodeBridge()
      ? streamConversationViaNodeBridge(ctx, chatBody)
      : this.streamConversationDirect(ctx, chatBody)

    for await (const line of upstream) {
      parseGptWebSSE(line, state)
    }

    if (!state.content) throw new Error('Empty response from GptWeb')
    return state.content
  }

  private async *streamConversationDirect(
    ctx: ReturnType<GptWebAccountPool['buildRequestContext']>,
    chatBody: Record<string, unknown>
  ): AsyncGenerator<string> {
    const sentinelTokens = await fetchSentinelTokens(ctx)
    const conduitToken = await fetchConduitToken(ctx, chatBody, sentinelTokens)
    yield* streamConversation(ctx, chatBody, sentinelTokens, conduitToken)
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
    id: `chatcmpl-${crypto.randomUUID()}`,
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
