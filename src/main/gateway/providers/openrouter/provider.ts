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
import {
  anthropicMessagesToOpenAIChatCompletions,
  openAIChatCompletionSseToAnthropicMessageSse,
  openAIChatCompletionToAnthropicMessage
} from '../../core/protocolAdapters'
import { OPENROUTER_BASE_URL, OPENROUTER_CHAT_COMPLETIONS_PATH } from './constants'
import {
  OpenRouterAccountPool,
  type OpenRouterAccountRuntime,
  classifyOpenRouterError,
  type OpenRouterClassifiedError
} from './accountPool'

const UPSTREAM_META = { category: 'upstream' as const, provider: 'openrouter' as const }

type RaceTask = {
  account: OpenRouterAccountRuntime
  controller: AbortController
  abortedAsLoser: boolean
  promise: Promise<RaceAttemptResult>
}

type RaceAttemptResult =
  | { kind: 'success'; parsed: any; responseText?: string; duration: number }
  | {
      kind: 'stream_success'
      reader: ReadableStreamDefaultReader<Uint8Array>
      decoder: TextDecoder
      firstText: string
      firstChunkLatencyMs: number
      duration: number
      usageChunk: any
    }
  | {
      kind: 'failure'
      error: unknown
      classified: OpenRouterClassifiedError
      duration: number
    }
  | { kind: 'aborted'; duration: number; client: boolean }

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

  async messages(body: any, context: GatewayRequestContext): Promise<GatewayResponse> {
    const model = String(body.model || '')
    const openAiBody = anthropicMessagesToOpenAIChatCompletions(body, model)
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
      limitRemaining: account.config.limitRemaining,
      raceStats: account.state.raceStats
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
    if (this.config.settings.requestRaceEnabled) {
      const accounts = await this.pool.getRaceAccountsForModel(
        model,
        this.config.settings.requestRaceMaxConcurrent
      )
      if (accounts.length >= 2) return this.nonStreamRaceProxy(model, body, context, accounts)
    }
    return this.nonStreamSerialProxy(model, body, context)
  }

  private async nonStreamSerialProxy(
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
        const res = await this.fetchUpstream(account, body, false, context.abortSignal)
        const responseBody = await res.text()
        if (!res.ok) {
          const classified = classifyOpenRouterError(res.status, responseBody)
          throw Object.assign(new Error(`HTTP ${res.status}: ${responseBody.slice(0, 500)}`), {
            classified
          })
        }
        const parsed = parseJsonResponse(responseBody)
        this.reportUsage(parsed, model, account, context)
        await this.pool.reportSuccess(account, Date.now() - startedAt)
        this.logger.info('OpenRouter upstream success', {
          ...UPSTREAM_META,
          requestId: context.requestId,
          accountId: account.config.label || account.config.id,
          model,
          duration: Date.now() - startedAt
        })
        return jsonResponse(200, parsed)
      } catch (error: any) {
        if (context.abortSignal?.aborted) {
          return jsonResponse(499, {
            error: { message: 'Client aborted request', type: 'client_aborted' }
          })
        }
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

  private async nonStreamRaceProxy(
    model: string,
    body: any,
    context: GatewayRequestContext,
    accounts: OpenRouterAccountRuntime[]
  ): Promise<GatewayResponse> {
    const tasks = accounts.map((account) =>
      this.createRaceTask(account, context, (task) => this.nonStreamRaceAttempt(task, body))
    )
    const pending = new Set(tasks)
    let lastError: unknown

    try {
      while (pending.size) {
        const { task, result } = await Promise.race(
          [...pending].map((task) => task.promise.then((result) => ({ task, result })))
        )
        pending.delete(task)
        if (result.kind === 'success') {
          abortRaceTasks(pending)
          this.reportUsage(result.parsed, model, task.account, context)
          await this.pool.reportSuccess(task.account, result.duration)
          this.logger.info('OpenRouter race upstream success', {
            ...UPSTREAM_META,
            requestId: context.requestId,
            accountId: task.account.config.label || task.account.config.id,
            model,
            duration: result.duration,
            extra: { racedAccounts: accounts.length }
          })
          return jsonResponse(200, result.parsed)
        }
        if (result.kind === 'aborted') {
          if (result.client) {
            abortRaceTasks(pending)
            return jsonResponse(499, {
              error: { message: 'Client aborted request', type: 'client_aborted' }
            })
          }
          continue
        }
        if (result.kind === 'failure') {
          lastError = result.error
          await this.pool.reportFailure(task.account, result.error, result.classified)
          this.logger.warn(`OpenRouter race upstream failed: ${toErrorMessage(result.error)}`, {
            ...UPSTREAM_META,
            requestId: context.requestId,
            accountId: task.account.config.label || task.account.config.id,
            model,
            duration: result.duration,
            extra: { kind: result.classified.kind, racedAccounts: accounts.length }
          })
        }
      }
    } finally {
      abortRaceTasks(pending)
    }

    const msg = toErrorMessage(lastError ?? 'No available OpenRouter accounts')
    return jsonResponse(502, { error: { message: msg, type: 'gateway_error' } })
  }

  private async *streamProxy(
    model: string,
    body: any,
    context: GatewayRequestContext
  ): AsyncGenerator<string> {
    if (this.config.settings.requestRaceEnabled) {
      const accounts = await this.pool.getRaceAccountsForModel(
        model,
        this.config.settings.requestRaceMaxConcurrent
      )
      if (accounts.length >= 2) {
        yield* this.streamRaceProxy(model, body, context, accounts)
        return
      }
    }
    yield* this.streamSerialProxy(model, body, context)
  }

  private async *streamSerialProxy(
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
          const res = await this.fetchUpstream(account, body, true, activeController.signal)
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
          try {
            while (true) {
              const { done, value } = await readWithTimeout(
                reader,
                this.config.settings.streamingReadTimeoutSeconds * 1000,
                activeController,
                'OpenRouter stream read timeout'
              )
              if (done) break
              const text = decoder.decode(value, { stream: true })
              yield text
              usageChunk = extractUsageChunk(text) ?? usageChunk
            }
          } finally {
            if (activeController.signal.aborted) await reader.cancel().catch(() => undefined)
          }
          if (usageChunk) this.reportUsage(usageChunk, model, account, context)
          await this.pool.reportSuccess(account, Date.now() - startedAt)
          this.logger.info('OpenRouter stream success', {
            ...UPSTREAM_META,
            requestId: context.requestId,
            accountId: account.config.label || account.config.id,
            model,
            duration: Date.now() - startedAt
          })
          return
        } catch (error: any) {
          if (context.abortSignal?.aborted) return
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
        } finally {
          unbindClientAbort()
          activeController = undefined
        }
      }
    } finally {
      activeController?.abort(new Error('OpenRouter stream closed'))
    }

    const message = `OpenRouter stream failed: ${toErrorMessage(lastError ?? 'No available accounts')}`
    yield sseData({ error: { message, type: 'gateway_error', code: 'openrouter_error' } })
    yield 'data: [DONE]\n\n'
  }

  private async *streamRaceProxy(
    model: string,
    body: any,
    context: GatewayRequestContext,
    accounts: OpenRouterAccountRuntime[]
  ): AsyncGenerator<string> {
    const tasks = accounts.map((account) =>
      this.createRaceTask(account, context, (task) => this.streamRaceFirstChunkAttempt(task, body))
    )
    const pending = new Set(tasks)
    let winner: RaceTask | undefined
    let winnerCompleted = false
    let lastError: unknown

    try {
      while (pending.size) {
        const { task, result } = await Promise.race(
          [...pending].map((task) => task.promise.then((result) => ({ task, result })))
        )
        pending.delete(task)
        if (result.kind === 'stream_success') {
          winner = task
          abortRaceTasks(pending)
          yield result.firstText
          let usageChunk = result.usageChunk
          try {
            while (true) {
              const { done, value } = await readWithTimeout(
                result.reader,
                this.config.settings.streamingReadTimeoutSeconds * 1000,
                task.controller,
                'OpenRouter stream read timeout'
              )
              if (done) break
              const text = result.decoder.decode(value, { stream: true })
              yield text
              usageChunk = extractUsageChunk(text) ?? usageChunk
            }
          } catch (error: any) {
            if (context.abortSignal?.aborted) return
            const classified = error.classified ?? classifyOpenRouterError(0, toErrorMessage(error))
            await this.pool.reportFailure(task.account, error, classified)
            throw error
          } finally {
            if (task.controller.signal.aborted) await result.reader.cancel().catch(() => undefined)
          }
          if (usageChunk) this.reportUsage(usageChunk, model, task.account, context)
          await this.pool.reportSuccess(task.account, result.firstChunkLatencyMs)
          winnerCompleted = true
          this.logger.info('OpenRouter race stream success', {
            ...UPSTREAM_META,
            requestId: context.requestId,
            accountId: task.account.config.label || task.account.config.id,
            model,
            duration: result.duration,
            timeToFirstToken: result.firstChunkLatencyMs,
            extra: { racedAccounts: accounts.length }
          })
          return
        }
        if (result.kind === 'aborted') {
          if (result.client) {
            abortRaceTasks(pending)
            return
          }
          continue
        }
        if (result.kind === 'failure') {
          lastError = result.error
          await this.pool.reportFailure(task.account, result.error, result.classified)
          this.logger.warn(`OpenRouter race stream failed: ${toErrorMessage(result.error)}`, {
            ...UPSTREAM_META,
            requestId: context.requestId,
            accountId: task.account.config.label || task.account.config.id,
            model,
            duration: result.duration,
            extra: { kind: result.classified.kind, racedAccounts: accounts.length }
          })
        }
      }
    } finally {
      abortRaceTasks(pending)
      if (!winnerCompleted) winner?.controller.abort(new Error('OpenRouter race stream closed'))
    }

    const message = `OpenRouter stream failed: ${toErrorMessage(lastError ?? 'No available accounts')}`
    yield sseData({ error: { message, type: 'gateway_error', code: 'openrouter_error' } })
    yield 'data: [DONE]\n\n'
  }

  private createRaceTask(
    account: OpenRouterAccountRuntime,
    context: GatewayRequestContext,
    run: (task: RaceTask) => Promise<RaceAttemptResult>
  ): RaceTask {
    const controller = new AbortController()
    const task: RaceTask = {
      account,
      controller,
      abortedAsLoser: false,
      promise: undefined as unknown as Promise<RaceAttemptResult>
    }
    bindAbortSignal(context.abortSignal, controller)
    task.promise = run(task)
    return task
  }

  private async nonStreamRaceAttempt(task: RaceTask, body: any): Promise<RaceAttemptResult> {
    const startedAt = Date.now()
    try {
      const res = await this.fetchUpstream(task.account, body, false, task.controller.signal)
      const responseBody = await res.text()
      if (!res.ok) {
        const classified = classifyOpenRouterError(res.status, responseBody)
        throw Object.assign(new Error(`HTTP ${res.status}: ${responseBody.slice(0, 500)}`), {
          classified
        })
      }
      return {
        kind: 'success',
        parsed: parseJsonResponse(responseBody),
        responseText: responseBody,
        duration: Date.now() - startedAt
      }
    } catch (error: any) {
      const duration = Date.now() - startedAt
      if (task.abortedAsLoser) return { kind: 'aborted', duration, client: false }
      if (!error.classified && task.controller.signal.aborted)
        return { kind: 'aborted', duration, client: true }
      return {
        kind: 'failure',
        error,
        classified: error.classified ?? classifyOpenRouterError(0, toErrorMessage(error)),
        duration
      }
    }
  }

  private async streamRaceFirstChunkAttempt(task: RaceTask, body: any): Promise<RaceAttemptResult> {
    const startedAt = Date.now()
    try {
      const res = await this.fetchUpstream(task.account, body, true, task.controller.signal)
      if (!res.ok) {
        const errBody = await res.text().catch(() => '')
        const classified = classifyOpenRouterError(res.status, errBody)
        throw Object.assign(new Error(`HTTP ${res.status}: ${errBody.slice(0, 500)}`), {
          classified
        })
      }
      if (!res.body) throw new Error('OpenRouter stream response has no body')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      const { done, value } = await readWithTimeout(
        reader,
        this.config.settings.firstTokenTimeoutSeconds * 1000,
        task.controller,
        'OpenRouter stream first chunk timeout'
      )
      if (done || !value) throw new Error('OpenRouter stream ended before first chunk')
      const firstText = decoder.decode(value, { stream: true })
      return {
        kind: 'stream_success',
        reader,
        decoder,
        firstText,
        firstChunkLatencyMs: Date.now() - startedAt,
        duration: Date.now() - startedAt,
        usageChunk: extractUsageChunk(firstText)
      }
    } catch (error: any) {
      const duration = Date.now() - startedAt
      if (task.abortedAsLoser) return { kind: 'aborted', duration, client: false }
      if (!error.classified && task.controller.signal.aborted)
        return { kind: 'aborted', duration, client: true }
      return {
        kind: 'failure',
        error,
        classified: error.classified ?? classifyOpenRouterError(0, toErrorMessage(error)),
        duration
      }
    }
  }

  private async fetchUpstream(
    account: OpenRouterAccountRuntime,
    body: any,
    stream: boolean,
    signal?: AbortSignal
  ): Promise<Response> {
    const baseUrl = this.config.settings.baseUrl || OPENROUTER_BASE_URL
    const url = joinUrl(baseUrl, OPENROUTER_CHAT_COMPLETIONS_PATH)
    const timeout = stream
      ? this.config.settings.streamingReadTimeoutSeconds * 1000
      : this.config.settings.firstTokenTimeoutSeconds * 1000
    const controller = new AbortController()
    const unbind = bindAbortSignal(signal, controller)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('OpenRouter upstream timeout'))
    }, timeout)
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
    } catch (error) {
      if (timedOut) throw new Error('OpenRouter upstream timeout')
      throw error
    } finally {
      clearTimeout(timer)
      if (!stream) unbind()
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

function abortRaceTasks(tasks: Set<RaceTask>): void {
  for (const task of tasks) {
    task.abortedAsLoser = true
    task.controller.abort(new Error('race loser'))
  }
  tasks.clear()
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
  let timeoutError: (Error & { classified?: OpenRouterClassifiedError }) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timeoutError = Object.assign(new Error(timeoutMessage), {
        classified: classifyOpenRouterError(0, timeoutMessage)
      })
      controller.abort(new Error(timeoutMessage))
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

function extractUsageChunk(text: string): any | null {
  const lines = text.split('\n')
  for (const line of lines) {
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
