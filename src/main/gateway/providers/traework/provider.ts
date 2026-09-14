import type {
  AccountStatus,
  AccountTestResult,
  GatewayRequestContext,
  GatewayResponse,
  ProviderAdapter,
  ProviderCheckinResult,
  ProviderModel,
  ProviderStatus,
  TraeWorkAccountConfig,
  TraeWorkProviderConfig,
  TraeWorkProviderState,
  UsageMeta,
  UsageStats
} from '../../types'
import { GatewayLogger } from '../../core/logger'
import { jsonResponse, sleep, sseData, toErrorMessage } from '../../core/utils'
import { DEFAULT_TRAEWORK_MODEL, describeTraeWorkModel, normalizeTraeWorkModel } from './constants'
import {
  TraeWorkAccountPool,
  type TraeWorkAccountRuntime,
  classifyTraeWorkError
} from './accountPool'
import { buildTraeWorkChatPayload } from './converters'
import { collectTraeWorkChat, streamTraeWorkChat, type TraeWorkStreamEvent } from './rawChat'
import {
  anthropicJsonFromResult,
  anthropicSseFromEvents,
  openAiJsonFromResult,
  openAiSseFromEvents
} from './streaming'

const UPSTREAM_META = { category: 'upstream' as const, provider: 'traework' as const }
const CHECKIN_INTERVAL_MS = 60 * 60_000
const CHECKIN_STARTUP_DELAY_MS = 20_000

export class TraeWorkProvider implements ProviderAdapter {
  readonly name = 'traework'
  private readonly pool: TraeWorkAccountPool
  private checkinTimer?: ReturnType<typeof setTimeout>
  private checkinInFlight = false

  constructor(
    private readonly config: TraeWorkProviderConfig,
    state: TraeWorkProviderState,
    private readonly logger: GatewayLogger,
    onStateChanged: () => void,
    persistAccount?: (accountId: string, updates: Partial<TraeWorkAccountConfig>) => Promise<void>
  ) {
    this.pool = new TraeWorkAccountPool(config, state, logger, onStateChanged, persistAccount)
  }

  async initialize(accountFiles: TraeWorkAccountConfig[]): Promise<void> {
    await this.pool.reload(accountFiles)
    this.scheduleCheckin(CHECKIN_STARTUP_DELAY_MS)
  }

  dispose(): void {
    if (this.checkinTimer) {
      clearTimeout(this.checkinTimer)
      this.checkinTimer = undefined
    }
  }

  async checkinAccounts(accountId?: string, force = false): Promise<ProviderCheckinResult> {
    return this.pool.checkinAccounts(accountId, force)
  }

  /**
   * Hourly self-rescheduling timer. Only schedules when the provider and
   * settings.autoCheckin are enabled; each tick runs the pool check-in which
   * no-ops for accounts already confirmed for the current CN day.
   */
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
            `TraeWork daily check-in: ${result.claimed} claimed, ${result.failed} failed`,
            { provider: 'traework', category: 'account' }
          )
        }
      } catch (error) {
        this.logger.warn(`TraeWork daily check-in sweep failed: ${toErrorMessage(error)}`, {
          provider: 'traework',
          category: 'account'
        })
      } finally {
        this.checkinInFlight = false
      }
    }
    this.scheduleCheckin(CHECKIN_INTERVAL_MS)
  }

  async listModels(): Promise<ProviderModel[]> {
    return (await this.pool.listModelsFresh()).map((id) => {
      const detail = describeTraeWorkModel(id)
      return {
        id,
        provider: 'traework',
        ownedBy: 'traework',
        description: detail ? `TraeWork ${detail.displayName}` : 'Model via TraeWork provider'
      }
    })
  }

  async chatCompletions(body: any, context: GatewayRequestContext): Promise<GatewayResponse> {
    const model = normalizeTraeWorkModel(String(body.model || DEFAULT_TRAEWORK_MODEL))
    if (body.stream === true) {
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
    const model = normalizeTraeWorkModel(String(body.model || DEFAULT_TRAEWORK_MODEL))
    if (body.stream === true) {
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
      authType: account.config.authType || 'traework-jwt',
      expiresAt: account.config.tokenExpiresAt
        ? new Date(account.config.tokenExpiresAt).toISOString()
        : undefined,
      status: account.state.status,
      statusReason: account.state.statusReason,
      statusUpdatedAt: account.state.statusUpdatedAt,
      cooldownUntil: account.state.cooldownUntil,
      lastResponseKind: account.state.lastResponseKind,
      countryCode: account.config.countryCode,
      checkin: account.state.checkin
    }))
    return {
      name: 'traework',
      providerType: 'traework',
      enabled: this.config.enabled,
      configured: accounts.length > 0,
      status: !this.config.enabled ? 'disabled' : accounts.length ? 'ready' : 'error',
      message: accounts.length
        ? `${accounts.length} account(s)`
        : 'No TraeWork accounts configured',
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
            onUsage(u, { accountId: account.config.id, model, provider: 'traework' })
        : undefined
      const startedAt = Date.now()
      try {
        const result = await this.callTraeWork(account, format, model, body)
        const response =
          format === 'openai'
            ? openAiJsonFromResult(result, model, body, sink)
            : anthropicJsonFromResult(result, model, body, sink)
        await this.pool.reportSuccess(account)
        this.logger.info('TraeWork upstream success', {
          ...UPSTREAM_META,
          requestId: rid,
          accountId: accountLabel(account),
          duration: Date.now() - startedAt
        })
        return response
      } catch (error) {
        lastError = error
        const classified = classifyTraeWorkError(error)
        await this.pool.reportFailure(account, error, classified)
        excluded.add(account.config.id)
        this.logger.warn(`TraeWork upstream failed: ${toErrorMessage(error)}`, {
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
    throw new Error(
      `TraeWork request failed: ${toErrorMessage(lastError ?? 'No available accounts')}`
    )
  }

  /**
   * Streaming with failover: pull the upstream event iterator until the first
   * content-bearing event (output/done/error). If the stream errors before any
   * content, rotate to the next account; once content flows, commit and yield
   * converted SSE downstream.
   */
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
            onUsage(u, { accountId: account.config.id, model, provider: 'traework' })
        : undefined
      const startedAt = Date.now()
      try {
        const payload = buildTraeWorkChatPayload(model, body, format, this.config.settings)
        const token = await account.auth!.getJwtToken()
        const iterator = streamTraeWorkChat({
          settings: this.config.settings,
          account: account.config,
          token,
          payload
        })[Symbol.asyncIterator]()
        // Buffer until the first content-bearing event so an early upstream
        // error can still fail over to another account.
        const buffered: TraeWorkStreamEvent[] = []
        let sawContent = false
        while (true) {
          const { done, value } = await iterator.next()
          if (done) break
          buffered.push(value)
          if (value.event === 'error') {
            throw new Error(
              `TraeWork upstream error ${value.data?.code ?? ''}: ${value.data?.message || formatEventError(value.data)}`
            )
          }
          if (value.event === 'output' || value.event === 'done') {
            sawContent = true
            break
          }
        }
        if (!sawContent) throw new Error('TraeWork stream ended without content')
        const events = concatEvents(buffered, iterator)
        yield* format === 'openai'
          ? openAiSseFromEvents(events, model, body, sink)
          : anthropicSseFromEvents(events, model, body, sink)
        await this.pool.reportSuccess(account)
        this.logger.info('TraeWork upstream success', {
          ...UPSTREAM_META,
          requestId: rid,
          accountId: accountLabel(account),
          duration: Date.now() - startedAt
        })
        return
      } catch (error) {
        lastError = error
        const classified = classifyTraeWorkError(error)
        await this.pool.reportFailure(account, error, classified)
        excluded.add(account.config.id)
        this.logger.warn(`TraeWork stream failed: ${toErrorMessage(error)}`, {
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
    const message = `TraeWork stream failed: ${toErrorMessage(lastError ?? 'No available accounts')}`
    if (format === 'openai') {
      yield sseData({ error: { message, type: 'gateway_error', code: 'traework_error' } })
      yield 'data: [DONE]\n\n'
    } else {
      yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`
    }
  }

  private async callTraeWork(
    account: TraeWorkAccountRuntime,
    format: 'openai' | 'anthropic',
    model: string,
    body: any
  ) {
    if (!account.auth) throw new Error('TraeWork account auth not initialized')
    const token = await account.auth.getJwtToken()
    return collectTraeWorkChat({
      settings: this.config.settings,
      account: account.config,
      token,
      payload: buildTraeWorkChatPayload(model, body, format, this.config.settings)
    })
  }
}

async function* concatEvents(
  buffered: TraeWorkStreamEvent[],
  iterator: AsyncIterator<TraeWorkStreamEvent>
): AsyncGenerator<TraeWorkStreamEvent> {
  for (const item of buffered) yield item
  while (true) {
    const { done, value } = await iterator.next()
    if (done) return
    yield value
  }
}

function formatEventError(data: any): string {
  try {
    return typeof data === 'string' ? data : JSON.stringify(data)
  } catch {
    return String(data)
  }
}

function sseHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  }
}

function accountLabel(account: TraeWorkAccountRuntime): string {
  return account.config.email || account.config.label || account.config.id
}
