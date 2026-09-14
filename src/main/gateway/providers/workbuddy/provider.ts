import type {
  AccountStatus,
  AccountTestResult,
  GatewayRequestContext,
  GatewayResponse,
  ProviderAdapter,
  ProviderCheckinResult,
  ProviderModel,
  ProviderStatus,
  UsageMeta,
  UsageStats,
  WorkBuddyAccountConfig,
  WorkBuddyProviderConfig,
  WorkBuddyProviderState
} from '../../types'
import { GatewayLogger } from '../../core/logger'
import { jsonResponse, sseData, sleep, toErrorMessage } from '../../core/utils'
import {
  anthropicMessagesToOpenAIChatCompletions,
  openAIChatCompletionSseToAnthropicMessageSse,
  openAIChatCompletionToAnthropicMessage
} from '../../core/protocolAdapters'
import {
  DEFAULT_WORKBUDDY_BACKEND,
  DEFAULT_WORKBUDDY_MODEL,
  WORKBUDDY_CHAT_PATH,
  normalizeWorkBuddyModel
} from './constants'
import {
  WorkBuddyAccountPool,
  type WorkBuddyAccountRuntime,
  classifyWorkBuddyError
} from './accountPool'
import { buildWorkBuddyHeaders } from './client'
import { joinUrl, workBuddyFetch } from './http'

const UPSTREAM_META = { category: 'upstream' as const, provider: 'workbuddy' as const }
const CHECKIN_INTERVAL_MS = 60 * 60_000
const CHECKIN_STARTUP_DELAY_MS = 25_000

/**
 * WorkBuddy upstream (copilot.tencent.com/v2/chat/completions) already speaks
 * OpenAI chat-completions wire format: requests are passed through with
 * stream:true forced (the backend only streams), responses relay SSE verbatim.
 * Anthropic /v1/messages traffic is converted via the shared protocolAdapters.
 */
export class WorkBuddyProvider implements ProviderAdapter {
  readonly name = 'workbuddy'
  private readonly pool: WorkBuddyAccountPool
  private checkinTimer?: ReturnType<typeof setTimeout>
  private checkinInFlight = false

  constructor(
    private readonly config: WorkBuddyProviderConfig,
    state: WorkBuddyProviderState,
    private readonly logger: GatewayLogger,
    onStateChanged: () => void,
    persistAccount?: (accountId: string, updates: Partial<WorkBuddyAccountConfig>) => Promise<void>
  ) {
    this.pool = new WorkBuddyAccountPool(config, state, logger, onStateChanged, persistAccount)
  }

  async initialize(accountFiles: WorkBuddyAccountConfig[]): Promise<void> {
    await this.pool.reload(accountFiles)
    this.scheduleCheckin(CHECKIN_STARTUP_DELAY_MS)
  }

  dispose(): void {
    if (this.checkinTimer) {
      clearTimeout(this.checkinTimer)
      this.checkinTimer = undefined
    }
  }

  async listModels(): Promise<ProviderModel[]> {
    return (await this.pool.listModelsFresh()).map((id) => ({
      id,
      provider: 'workbuddy',
      ownedBy: 'workbuddy',
      description: 'Model via WorkBuddy provider'
    }))
  }

  async chatCompletions(body: any, context: GatewayRequestContext): Promise<GatewayResponse> {
    const model = normalizeWorkBuddyModel(body.model || DEFAULT_WORKBUDDY_MODEL)
    const upstreamBody = prepareUpstreamBody(body)
    if (body.stream === true) {
      return {
        status: 200,
        headers: sseHeaders(),
        stream: this.streamProxy(model, upstreamBody, context)
      }
    }
    return this.nonStreamProxy(model, upstreamBody, context)
  }

  async messages(body: any, context: GatewayRequestContext): Promise<GatewayResponse> {
    const model = normalizeWorkBuddyModel(body.model || DEFAULT_WORKBUDDY_MODEL)
    const openAiBody = prepareUpstreamBody(anthropicMessagesToOpenAIChatCompletions(body, model))
    if (body.stream === true) {
      return {
        status: 200,
        headers: sseHeaders(),
        stream: openAIChatCompletionSseToAnthropicMessageSse(
          this.streamProxy(model, openAiBody, context),
          model
        )
      }
    }
    const response = await this.nonStreamProxy(model, openAiBody, context)
    if (response.status >= 400) return response
    return jsonResponse(
      response.status,
      openAIChatCompletionToAnthropicMessage(response.body, model, body)
    )
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

  async checkinAccounts(accountId?: string, force = false): Promise<ProviderCheckinResult> {
    return this.pool.checkinAccounts(accountId, force)
  }

  async getStatus(): Promise<ProviderStatus & { accounts: any[] }> {
    const accounts = this.pool.listAccounts().map((account) => ({
      id: account.config.id,
      label: account.config.label || account.config.nickname || account.config.email,
      email: account.config.email,
      enabled: account.config.enabled !== false,
      failures: account.state.failures,
      lastError: account.state.lastError,
      lastSuccessAt: account.state.lastSuccessAt,
      lastFailureAt: account.state.lastFailureAt,
      models: account.state.modelIds,
      stats: account.state.stats,
      authType: account.config.authType || 'workbuddy-token',
      expiresAt: account.config.tokenExpiresAt
        ? new Date(account.config.tokenExpiresAt).toISOString()
        : undefined,
      status: account.state.status,
      statusReason: account.state.statusReason,
      statusUpdatedAt: account.state.statusUpdatedAt,
      cooldownUntil: account.state.cooldownUntil,
      lastResponseKind: account.state.lastResponseKind,
      domain: account.config.domain,
      checkin: account.state.checkin
    }))
    return {
      name: 'workbuddy',
      providerType: 'workbuddy',
      enabled: this.config.enabled,
      configured: accounts.length > 0,
      status: !this.config.enabled ? 'disabled' : accounts.length ? 'ready' : 'error',
      message: accounts.length
        ? `${accounts.length} account(s)`
        : 'No WorkBuddy accounts configured',
      models: this.pool.listModels(),
      accounts
    }
  }

  private scheduleCheckin(delayMs: number): void {
    if (this.checkinTimer) clearTimeout(this.checkinTimer)
    if (!this.config.enabled || this.config.settings.autoCheckin === false) return
    this.checkinTimer = setTimeout(() => {
      this.checkinTimer = undefined
      void this.runScheduledCheckin()
    }, delayMs)
    this.checkinTimer.unref?.()
  }

  private async runScheduledCheckin(): Promise<void> {
    if (!this.checkinInFlight) {
      this.checkinInFlight = true
      try {
        const result = await this.pool.checkinAccounts()
        if (result.claimed || result.failed) {
          this.logger.info(
            `WorkBuddy daily check-in: ${result.claimed} claimed, ${result.failed} failed`,
            { provider: 'workbuddy', category: 'account' }
          )
        }
      } catch (error) {
        this.logger.warn(`WorkBuddy daily check-in sweep failed: ${toErrorMessage(error)}`, {
          provider: 'workbuddy',
          category: 'account'
        })
      } finally {
        this.checkinInFlight = false
      }
    }
    this.scheduleCheckin(CHECKIN_INTERVAL_MS)
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
        const res = await this.fetchUpstream(account, body, context.abortSignal)
        if (!res.ok) {
          const errBody = await res.text().catch(() => '')
          throw Object.assign(new Error(`HTTP ${res.status}: ${errBody.slice(0, 500)}`), {
            classified: classifyWorkBuddyError(
              Object.assign(new Error(errBody), { name: `Http${res.status}` })
            )
          })
        }
        // Backend only streams — collect the SSE body into a single response.
        const collected = await collectSseChat(res)
        this.reportUsage(collected, model, account, context)
        await this.pool.reportSuccess(account, Date.now() - startedAt)
        this.logger.info('WorkBuddy upstream success', {
          ...UPSTREAM_META,
          requestId: context.requestId,
          accountId: accountLabel(account),
          model,
          duration: Date.now() - startedAt
        })
        return jsonResponse(200, collected)
      } catch (error: any) {
        if (context.abortSignal?.aborted) {
          return jsonResponse(499, {
            error: { message: 'Client aborted request', type: 'client_aborted' }
          })
        }
        lastError = error
        const classified = error.classified ?? classifyWorkBuddyError(error)
        await this.pool.reportFailure(account, error, classified)
        excluded.add(account.config.id)
        this.logger.warn(`WorkBuddy upstream failed: ${toErrorMessage(error)}`, {
          ...UPSTREAM_META,
          requestId: context.requestId,
          accountId: accountLabel(account),
          model,
          duration: Date.now() - startedAt,
          extra: { kind: classified.kind, attempt: attempt + 1 }
        })
        if (classified.kind === 'auth' || classified.kind === 'quota') break
        await sleep(300 * Math.pow(2, attempt))
      }
    }
    const msg = toErrorMessage(lastError ?? 'No available WorkBuddy accounts')
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
    let activeController: AbortController | undefined

    try {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const account = await this.pool.getAccountForModel(model, excluded)
        if (!account) break
        const startedAt = Date.now()
        activeController = new AbortController()
        const unbindClientAbort = bindAbortSignal(context.abortSignal, activeController)
        try {
          const res = await this.fetchUpstream(account, body, activeController.signal)
          if (!res.ok) {
            const errBody = await res.text().catch(() => '')
            throw Object.assign(new Error(`HTTP ${res.status}: ${errBody.slice(0, 500)}`), {
              classified: classifyWorkBuddyError(new Error(`HTTP ${res.status}`))
            })
          }
          const reader = res.body!.getReader()
          const decoder = new TextDecoder()
          let buffered = ''
          let sawData = false
          let usageChunk: any = null
          try {
            while (true) {
              const { done, value } = await readWithTimeout(
                reader,
                this.config.settings.streamingReadTimeoutSeconds * 1000,
                activeController,
                'WorkBuddy stream read timeout'
              )
              if (done) break
              const text = decoder.decode(value, { stream: true })
              buffered += text
              // Only forward once we see a parseable data frame — an early
              // upstream error can still fail over before committing.
              if (!sawData) {
                if (buffered.includes('data:') && buffered.includes('\n')) {
                  sawData = true
                  yield buffered
                  buffered = ''
                }
              } else {
                yield text
              }
              usageChunk = extractUsageChunk(text) ?? usageChunk
            }
            if (buffered) yield buffered
          } finally {
            if (activeController.signal.aborted) await reader.cancel().catch(() => undefined)
          }
          if (!sawData) throw new Error('WorkBuddy stream ended without data')
          if (usageChunk) this.reportUsage(usageChunk, model, account, context)
          await this.pool.reportSuccess(account, Date.now() - startedAt)
          this.logger.info('WorkBuddy stream success', {
            ...UPSTREAM_META,
            requestId: context.requestId,
            accountId: accountLabel(account),
            model,
            duration: Date.now() - startedAt
          })
          return
        } catch (error: any) {
          if (context.abortSignal?.aborted) return
          lastError = error
          const classified = error.classified ?? classifyWorkBuddyError(error)
          await this.pool.reportFailure(account, error, classified)
          excluded.add(account.config.id)
          this.logger.warn(`WorkBuddy stream failed: ${toErrorMessage(error)}`, {
            ...UPSTREAM_META,
            requestId: context.requestId,
            accountId: accountLabel(account),
            model,
            duration: Date.now() - startedAt,
            extra: { kind: classified.kind, attempt: attempt + 1 }
          })
          if (classified.kind === 'auth' || classified.kind === 'quota') break
          await sleep(300 * Math.pow(2, attempt))
        } finally {
          unbindClientAbort()
          activeController = undefined
        }
      }
    } finally {
      activeController?.abort(new Error('WorkBuddy stream closed'))
    }

    const message = `WorkBuddy stream failed: ${toErrorMessage(lastError ?? 'No available accounts')}`
    yield sseData({ error: { message, type: 'gateway_error', code: 'workbuddy_error' } })
    yield 'data: [DONE]\n\n'
  }

  private async fetchUpstream(
    account: WorkBuddyAccountRuntime,
    body: any,
    signal?: AbortSignal
  ): Promise<Response> {
    if (!account.auth) throw new Error('WorkBuddy account auth not initialized')
    const token = await account.auth.getAccessToken()
    const base = this.config.settings.backend || DEFAULT_WORKBUDDY_BACKEND
    const timeout =
      this.config.settings.firstTokenTimeoutSeconds * 1000 +
      this.config.settings.streamingReadTimeoutSeconds * 1000
    const controller = new AbortController()
    const unbind = bindAbortSignal(signal, controller)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('WorkBuddy upstream timeout'))
    }, timeout)
    timer.unref?.()
    try {
      return await workBuddyFetch(
        joinUrl(base, WORKBUDDY_CHAT_PATH),
        {
          method: 'POST',
          headers: buildWorkBuddyHeaders(account.config, token),
          body: JSON.stringify(body),
          signal: controller.signal
        },
        this.config.settings
      )
    } catch (error) {
      if (timedOut) throw new Error('WorkBuddy upstream timeout')
      throw error
    } finally {
      clearTimeout(timer)
      unbind()
    }
  }

  private reportUsage(
    parsed: any,
    model: string,
    account: WorkBuddyAccountRuntime,
    context: GatewayRequestContext
  ): void {
    if (!context.onUsage || !parsed?.usage) return
    const u = parsed.usage
    const usage: UsageStats = {
      inputTokens: u.prompt_tokens || 0,
      outputTokens: u.completion_tokens || 0
    }
    const meta: UsageMeta = { accountId: account.config.id, model, provider: 'workbuddy' }
    context.onUsage(usage, meta)
  }
}

/**
 * Tencent backend quirks:
 * - stream:true is required (non-stream requests are rejected).
 * - `developer` role trips the safety layer (error 11128) → mapped to system.
 */
function prepareUpstreamBody(body: any): any {
  const out: any = { ...body, stream: true }
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((m: any) =>
      m && typeof m === 'object' && m.role === 'developer' ? { ...m, role: 'system' } : m
    )
  }
  if (!out.stream_options) out.stream_options = { include_usage: true }
  return out
}

/**
 * Collects an OpenAI chat-completions SSE body into a single
 * chat.completion-shaped response for non-streaming clients.
 */
async function collectSseChat(res: Response): Promise<any> {
  const text = await res.text()
  const message: any = { role: 'assistant', content: '' }
  let model = ''
  let id = ''
  let created = 0
  let usage: any = null
  let finishReason: string | null = null
  const toolCalls = new Map<number, any>()
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '[DONE]') continue
    let chunk: any
    try {
      chunk = JSON.parse(data)
    } catch {
      continue
    }
    if (chunk.id) id = chunk.id
    if (chunk.model) model = chunk.model
    if (chunk.created) created = chunk.created
    if (chunk.usage) usage = chunk.usage
    const choice = chunk.choices?.[0]
    if (!choice) continue
    const delta = choice.delta || {}
    if (typeof delta.content === 'string') message.content += delta.content
    if (typeof delta.reasoning_content === 'string') {
      message.reasoning_content = (message.reasoning_content || '') + delta.reasoning_content
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        const existing = toolCalls.get(idx) ?? {
          id: tc.id,
          type: 'function',
          function: { name: '', arguments: '' }
        }
        if (tc.id) existing.id = tc.id
        if (tc.function?.name) existing.function.name += tc.function.name
        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
        toolCalls.set(idx, existing)
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason
  }
  if (toolCalls.size) message.tool_calls = [...toolCalls.values()]
  return {
    id: id || 'chatcmpl-workbuddy',
    object: 'chat.completion',
    created: created || Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason || 'stop' }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  }
}

function extractUsageChunk(text: string): any | null {
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ') && line.includes('"usage"')) {
      try {
        const parsed = JSON.parse(line.slice(6))
        if (parsed.usage) return parsed
      } catch {
        /* ignore parse errors in stream */
      }
    }
  }
  return null
}

function bindAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined
  if (signal.aborted) {
    controller.abort(signal.reason)
    return () => undefined
  }
  const onAbort = (): void => controller.abort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  return () => signal.removeEventListener('abort', onAbort)
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  controller: AbortController,
  timeoutMessage: string
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeoutError: Error | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timeoutError = new Error(timeoutMessage)
      controller.abort(timeoutError)
      reject(timeoutError)
    }, timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([reader.read(), timeoutPromise])
  } catch (error) {
    if (timeoutError) throw timeoutError
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function sseHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  }
}

function accountLabel(account: WorkBuddyAccountRuntime): string {
  return account.config.label || account.config.nickname || account.config.id
}
