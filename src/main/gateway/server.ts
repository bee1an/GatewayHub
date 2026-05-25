import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { ApiKeyEntry, GatewayHubConfig, GatewayResponse, UsageStats, UsageMeta } from './types'
import { GatewayLogger } from './core/logger'
import { parseRequestBody, requestId, toErrorMessage } from './core/utils'
import { wrapStreamForTracing, type RequestTrace } from './core/requestTracer'
import { ProviderRegistry } from './providerRegistry'
import { PricingTable } from './core/pricing'
import { UsageStore } from './core/usageStore'

export class GatewayServer {
  private server?: Server
  onApiKeyUsed?: (id: string) => void

  constructor(
    private config: GatewayHubConfig,
    private readonly registry: ProviderRegistry,
    private readonly logger: GatewayLogger,
    private readonly pricing: PricingTable,
    private readonly usageStore: UsageStore
  ) {}

  updateConfig(config: GatewayHubConfig): void {
    this.config = config
  }

  get running(): boolean {
    return Boolean(this.server?.listening)
  }

  get url(): string {
    return `http://${this.config.server.host}:${this.config.server.port}`
  }

  async start(): Promise<void> {
    if (this.running) return
    this.server = createServer((req, res) => void this.handle(req, res))
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error)
        this.server!.once('error', onError)
        this.server!.listen(this.config.server.port, this.config.server.host, () => {
          this.server!.off('error', onError)
          resolve()
        })
      })
    } catch (err) {
      const friendly = this.translateListenError(err)
      this.server = undefined
      this.logger.error(friendly.message, { category: 'system' })
      const wrapped = new Error(friendly.message) as Error & { code?: string }
      if (friendly.code) wrapped.code = friendly.code
      throw wrapped
    }
    this.logger.info(`Gateway server listening on ${this.url}`, { category: 'system' })
  }

  private translateListenError(err: unknown): { message: string; code?: string } {
    const e = err as NodeJS.ErrnoException
    const { host, port } = this.config.server
    if (e?.code === 'EADDRINUSE') {
      return {
        code: 'EADDRINUSE',
        message: `Port ${port} on ${host} is already in use. Stop the other process or change the port in Settings.`
      }
    }
    if (e?.code === 'EACCES') {
      return {
        code: 'EACCES',
        message: `Permission denied to bind ${host}:${port}. Try a port above 1024 or run with elevated permissions.`
      }
    }
    if (e?.code === 'EADDRNOTAVAIL') {
      return {
        code: 'EADDRNOTAVAIL',
        message: `Host ${host} is not available on this machine. Update the host in Settings.`
      }
    }
    return { message: e?.message || 'Failed to start gateway server' }
  }

  async stop(): Promise<void> {
    if (!this.server) return
    const server = this.server
    this.server = undefined
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
    this.logger.info('Gateway server stopped', { category: 'system' })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setCors(res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url || '/', this.url)
    const rid = requestId()
    const startedAt = Date.now()

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return this.writeJson(res, 200, {
          status: 'healthy',
          service: 'GatewayHub',
          version: 1,
          url: this.url,
          timestamp: new Date().toISOString()
        })
      }
      if (req.method === 'GET' && url.pathname === '/') {
        return this.writeJson(res, 200, { status: 'ok', message: 'GatewayHub is running' })
      }

      if (!this.verifyApiKey(req)) {
        this.logger.warn('Authentication failed: invalid or missing API key', {
          requestId: rid,
          category: 'auth',
          statusCode: 401
        })
        return this.writeJson(res, 401, {
          error: { message: 'Invalid or missing API key', type: 'authentication_error' }
        })
      }

      const apiKeyEntry = this.verifyApiKey(req)!
      if (apiKeyEntry.id) this.onApiKeyUsed?.(apiKeyEntry.id)

      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const models = await this.registry.listModels()
        this.logger.info(`${req.method} ${url.pathname}`, {
          requestId: rid,
          category: 'request',
          statusCode: 200,
          duration: Date.now() - startedAt
        })
        return this.writeJson(res, 200, {
          object: 'list',
          data: models.map((model) => ({
            id: model.id,
            object: 'model',
            created: 0,
            owned_by: 'gatewayhub'
          }))
        })
      }

      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await parseRequestBody(req)
        if (!this.checkScope(apiKeyEntry, body.model, res, rid)) return
        this.logger.info(`POST /v1/chat/completions model=${body.model || 'default'}`, {
          requestId: rid,
          category: 'request',
          extra: { apiFormat: 'openai', stream: body.stream !== false }
        })
        const trace: RequestTrace = {
          requestId: rid,
          method: 'POST',
          path: url.pathname,
          model: body.model,
          apiFormat: 'openai',
          startedAt
        }
        const response = await this.registry.chatCompletions(body, {
          requestId: rid,
          apiFormat: 'openai',
          onUsage: this.makeUsageSink(trace)
        })
        return this.writeTracedResponse(res, response, trace)
      }

      if (req.method === 'POST' && url.pathname === '/v1/messages') {
        const body = await parseRequestBody(req)
        if (!this.checkScope(apiKeyEntry, body.model, res, rid)) return
        this.logger.info(`POST /v1/messages model=${body.model || 'default'}`, {
          requestId: rid,
          category: 'request',
          extra: { apiFormat: 'anthropic', stream: body.stream === true }
        })
        const trace: RequestTrace = {
          requestId: rid,
          method: 'POST',
          path: url.pathname,
          model: body.model,
          apiFormat: 'anthropic',
          startedAt
        }
        const response = await this.registry.messages(body, {
          requestId: rid,
          apiFormat: 'anthropic',
          onUsage: this.makeUsageSink(trace)
        })
        return this.writeTracedResponse(res, response, trace)
      }

      if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
        const body = await parseRequestBody(req)
        if (!this.checkScope(apiKeyEntry, body.model, res, rid)) return
        const response = await this.registry.countTokens(body, {
          requestId: rid,
          apiFormat: 'anthropic'
        })
        this.logger.info(`POST /v1/messages/count_tokens model=${body.model || 'default'}`, {
          requestId: rid,
          category: 'request',
          statusCode: response.status,
          duration: Date.now() - startedAt
        })
        return this.writeGatewayResponse(res, response)
      }

      return this.writeJson(res, 404, {
        error: { message: `Not found: ${url.pathname}`, type: 'not_found' }
      })
    } catch (error) {
      const duration = Date.now() - startedAt
      this.logger.error(`HTTP request failed: ${toErrorMessage(error)}`, {
        requestId: rid,
        category: 'request',
        statusCode: 500,
        duration,
        error: {
          stack: error instanceof Error ? error.stack : undefined
        }
      })
      return this.writeJson(res, 500, {
        error: { message: toErrorMessage(error), type: 'gateway_error' }
      })
    }
  }

  private verifyApiKey(req: IncomingMessage): ApiKeyEntry | null {
    const entries = this.config.server.apiKeys
    const auth = req.headers.authorization
    const xApiKey = req.headers['x-api-key'] as string | undefined
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined
    const provided = token || xApiKey || ''
    if (!entries?.length) return provided ? null : null
    const entry = entries.find((e) => e.key === provided)
    if (!entry) return null
    if (entry.expiresAt && Date.now() > entry.expiresAt) return null
    return entry
  }

  private checkScope(
    entry: ApiKeyEntry,
    model: string | undefined,
    res: ServerResponse,
    rid: string
  ): boolean {
    if (!entry.scopes?.length) return true
    const raw = model || ''
    const slash = raw.indexOf('/')
    const provider = slash > 0 ? raw.slice(0, slash) : ''
    if (!provider || entry.scopes.includes(provider)) return true
    this.logger.warn(`API key "${entry.name}" denied access to provider "${provider}"`, {
      requestId: rid,
      category: 'auth',
      statusCode: 403
    })
    this.writeJson(res, 403, {
      error: {
        message: `API key "${entry.name}" does not have access to provider "${provider}"`,
        type: 'permission_error'
      }
    })
    return false
  }

  private async writeTracedResponse(
    res: ServerResponse,
    response: GatewayResponse,
    trace: RequestTrace
  ): Promise<void> {
    trace.statusCode = response.status
    trace.streaming = Boolean(response.stream)
    const headers = response.headers ?? { 'content-type': 'application/json; charset=utf-8' }
    res.writeHead(response.status, headers)

    if (response.stream) {
      const tracedStream = wrapStreamForTracing(response.stream, trace, (t) => {
        if (t.usage) {
          const cost = this.pricing.compute(t.model, t.usage, t.provider)
          t.cost = cost.known ? cost : undefined
        }
        this.logger.info(`${t.method} ${t.path} completed`, {
          requestId: t.requestId,
          accountId: t.accountId,
          provider: t.provider,
          category: 'request',
          statusCode: t.statusCode,
          duration: t.duration,
          streaming: true,
          timeToFirstToken: t.timeToFirstToken,
          chunkCount: t.chunkCount,
          model: t.model,
          apiFormat: t.apiFormat,
          usage: t.usage,
          cost: t.cost
        })
      })
      for await (const chunk of tracedStream) res.write(chunk)
      res.end()
      return
    }

    trace.duration = Date.now() - trace.startedAt
    if (trace.usage) {
      const cost = this.pricing.compute(trace.model, trace.usage, trace.provider)
      trace.cost = cost.known ? cost : undefined
    }
    this.logger.info(`${trace.method} ${trace.path} completed`, {
      requestId: trace.requestId,
      accountId: trace.accountId,
      provider: trace.provider,
      category: 'request',
      statusCode: trace.statusCode,
      duration: trace.duration,
      streaming: false,
      model: trace.model,
      apiFormat: trace.apiFormat,
      usage: trace.usage,
      cost: trace.cost
    })

    if (response.body === undefined) res.end()
    else res.end(typeof response.body === 'string' ? response.body : JSON.stringify(response.body))
  }

  private async writeGatewayResponse(
    res: ServerResponse,
    response: GatewayResponse
  ): Promise<void> {
    const headers = response.headers ?? { 'content-type': 'application/json; charset=utf-8' }
    res.writeHead(response.status, headers)
    if (response.stream) {
      for await (const chunk of response.stream) res.write(chunk)
      res.end()
      return
    }
    if (response.body === undefined) res.end()
    else res.end(typeof response.body === 'string' ? response.body : JSON.stringify(response.body))
  }

  private writeJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  /**
   * 构造 onUsage 回调：流尾或非流响应解析完毕时调用一次。
   * - 把 usage / accountId 写到 trace，便于后续 logger 打印
   * - 异步落到 UsageStore（持久化今日累计）
   */
  private makeUsageSink(trace: RequestTrace): (usage: UsageStats, meta?: UsageMeta) => void {
    return (usage, meta) => {
      trace.usage = usage
      if (meta?.accountId) trace.accountId = meta.accountId
      if (meta?.model) trace.model = meta.model
      if (meta?.provider) trace.provider = meta.provider
      // record 是 fire-and-forget；store 内部串行队列保证顺序
      void this.usageStore
        .record({
          accountId: meta?.accountId,
          model: meta?.model ?? trace.model,
          provider: meta?.provider ?? trace.provider,
          apiFormat: trace.apiFormat,
          usage
        })
        .catch((error) => {
          this.logger.warn(`Usage store record failed: ${toErrorMessage(error)}`, {
            requestId: trace.requestId,
            category: 'system'
          })
        })
    }
  }
}

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'authorization,x-api-key,anthropic-version,content-type'
  )
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
}
