import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { once } from 'events'
import type { ApiKeyEntry, GatewayHubConfig, GatewayResponse, UsageStats, UsageMeta } from './types'
import { GatewayLogger } from './core/logger'
import { parseRequestBody, requestId, sseData, toErrorMessage } from './core/utils'
import {
  HEAD_TIMEOUT_MS,
  HEADERS_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  MAX_BODY_BYTES,
  STOP_FORCE_CLOSE_MS,
  isAllowedHostHeader,
  isAllowedOrigin,
  isLoopbackHost,
  safeEqualString
} from './core/http'
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
    // 显式收紧超时，避免慢攻击占用 socket。
    // - headersTimeout 限制 request line + headers 总耗时
    // - requestTimeout=0 关闭整体请求超时（流式响应可能跑得很久）
    // - keepAliveTimeout 控制空闲连接保留时间
    this.server.headersTimeout = HEADERS_TIMEOUT_MS
    this.server.requestTimeout = 0
    this.server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS
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

    // 先把空闲 keep-alive 连接踢掉，让 close() 不被它们拖住。
    type ServerWithCloseHelpers = Server & {
      closeIdleConnections?: () => void
      closeAllConnections?: () => void
    }
    const s = server as ServerWithCloseHelpers
    try {
      s.closeIdleConnections?.()
    } catch {
      /* ignore */
    }

    let forceTimer: NodeJS.Timeout | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        // 兜底：长流式连接挂着不放时，超时后强行关掉所有连接。
        forceTimer = setTimeout(() => {
          try {
            s.closeAllConnections?.()
          } catch {
            /* ignore */
          }
        }, STOP_FORCE_CLOSE_MS)
        if (typeof forceTimer.unref === 'function') forceTimer.unref()

        server.close((error) => (error ? reject(error) : resolve()))
      })
    } finally {
      if (forceTimer) clearTimeout(forceTimer)
    }
    this.logger.info('Gateway server stopped', { category: 'system' })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 防止慢请求占着 socket：读 headers/body 超时即 408。
    // 不影响后续流式响应——上游开始推送后我们会 setTimeout(0) 关闭定时器。
    const onSocketTimeout = (): void => {
      if (res.headersSent) {
        try {
          res.end()
        } catch {
          /* ignore */
        }
        return
      }
      try {
        res.writeHead(408, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({
            error: { message: 'Request timed out', type: 'timeout_error' }
          })
        )
      } catch {
        /* ignore */
      }
    }
    req.setTimeout(HEAD_TIMEOUT_MS, onSocketTimeout)

    this.applyCors(req, res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // DNS rebinding 防御：当服务器只听回环时，强制 Host 必须是回环主机。
    // 绑定到 0.0.0.0 / 公开 IP 时跳过（这种部署反正必须靠 API key 鉴权）。
    if (!this.checkHostHeader(req, res)) return

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

      // 同一请求只调用一次 verifyApiKey，避免重复哈希比较与日志竞态。
      const apiKeyEntry = this.verifyApiKey(req)
      if (!apiKeyEntry) {
        this.logger.warn('Authentication failed: invalid or missing API key', {
          requestId: rid,
          category: 'auth',
          statusCode: 401
        })
        return this.writeJson(res, 401, {
          error: { message: 'Invalid or missing API key', type: 'authentication_error' }
        })
      }
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
        const body = await parseRequestBody(req, MAX_BODY_BYTES)
        if (!this.checkScope(apiKeyEntry, body?.model, res, rid)) return
        this.logger.info(`POST /v1/chat/completions model=${body?.model || 'default'}`, {
          requestId: rid,
          category: 'request',
          extra: { apiFormat: 'openai', stream: body?.stream !== false }
        })
        const trace: RequestTrace = {
          requestId: rid,
          method: 'POST',
          path: url.pathname,
          model: body?.model,
          apiFormat: 'openai',
          startedAt
        }
        const upstreamAbort = new AbortController()
        const unbindClientAbort = this.bindClientAbort(req, res, upstreamAbort)
        try {
          const response = await this.registry.chatCompletions(body, {
            requestId: rid,
            apiFormat: 'openai',
            onUsage: this.makeUsageSink(trace),
            abortSignal: upstreamAbort.signal
          })
          return await this.writeTracedResponse(req, res, response, trace)
        } finally {
          unbindClientAbort()
        }
      }

      if (req.method === 'POST' && url.pathname === '/v1/messages') {
        const body = await parseRequestBody(req, MAX_BODY_BYTES)
        if (!this.checkScope(apiKeyEntry, body?.model, res, rid)) return
        this.logger.info(`POST /v1/messages model=${body?.model || 'default'}`, {
          requestId: rid,
          category: 'request',
          extra: { apiFormat: 'anthropic', stream: body?.stream === true }
        })
        const trace: RequestTrace = {
          requestId: rid,
          method: 'POST',
          path: url.pathname,
          model: body?.model,
          apiFormat: 'anthropic',
          startedAt
        }
        const upstreamAbort = new AbortController()
        const unbindClientAbort = this.bindClientAbort(req, res, upstreamAbort)
        try {
          const response = await this.registry.messages(body, {
            requestId: rid,
            apiFormat: 'anthropic',
            onUsage: this.makeUsageSink(trace),
            abortSignal: upstreamAbort.signal
          })
          return await this.writeTracedResponse(req, res, response, trace)
        } finally {
          unbindClientAbort()
        }
      }

      if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
        const body = await parseRequestBody(req, MAX_BODY_BYTES)
        if (!this.checkScope(apiKeyEntry, body?.model, res, rid)) return
        const response = await this.registry.countTokens(body, {
          requestId: rid,
          apiFormat: 'anthropic'
        })
        this.logger.info(`POST /v1/messages/count_tokens model=${body?.model || 'default'}`, {
          requestId: rid,
          category: 'request',
          statusCode: response.status,
          duration: Date.now() - startedAt
        })
        return this.writeGatewayResponse(req, res, response)
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
      // headers 已经发出去了就不能再写一份 JSON，否则会破坏前端解析。
      // 流式响应的错误处理由 writeTracedResponse 内部负责（写一个 SSE error 块）。
      if (!res.headersSent) {
        return this.writeJson(res, 500, {
          error: { message: toErrorMessage(error), type: 'gateway_error' }
        })
      }
      try {
        res.end()
      } catch {
        /* ignore */
      }
      return
    }
  }

  /**
   * 校验请求 API key。
   * - 长度不一致直接 reject（避免 timingSafeEqual 抛错并让分支可观测）
   * - 一致长度走常量时间比较，防止 timing oracle
   * - 同一请求只调一次（调用方拿到结果后复用）
   */
  private verifyApiKey(req: IncomingMessage): ApiKeyEntry | null {
    const entries = this.config.server.apiKeys
    const auth = req.headers.authorization
    const xApiKey = req.headers['x-api-key'] as string | undefined
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined
    const provided = token || xApiKey || ''
    // 没有配置任何 key = 禁止访问（避免误以为「空 key 就放行」）。
    if (!entries?.length) return null
    if (!provided) return null

    let matched: ApiKeyEntry | null = null
    for (const entry of entries) {
      // 不要短路：哪怕第一条匹配上也跑完所有条目，避免按顺序爆破时的时间侧信道。
      if (safeEqualString(entry.key, provided)) matched = matched ?? entry
    }
    if (!matched) return null
    if (matched.expiresAt && Date.now() > matched.expiresAt) return null
    return matched
  }

  private checkHostHeader(req: IncomingMessage, res: ServerResponse): boolean {
    const bindHost = this.config.server.host
    if (!isLoopbackHost(bindHost)) return true
    const hostHeader = (req.headers.host || '').toString()
    if (isAllowedHostHeader(hostHeader, this.config.server.port)) return true
    this.logger.warn(`Rejected request with unexpected Host header: ${hostHeader || '(empty)'}`, {
      category: 'auth',
      statusCode: 421
    })
    res.writeHead(421, { 'content-type': 'application/json; charset=utf-8' })
    res.end(
      JSON.stringify({
        error: { message: 'Misdirected request: invalid Host header', type: 'host_mismatch' }
      })
    )
    return false
  }

  /**
   * CORS 策略：
   * - 服务器绑定回环时，仅当 Origin 在本地客户端白名单（localhost / 127.0.0.1 /
   *   [::1] / file:// / app:// / vscode-webview://）时回显 ACAO。
   * - 服务器绑定 0.0.0.0 或公开 IP 时不发送 ACAO（必须靠 API key 鉴权，浏览器端
   *   也用不上跨域调用）。
   * - 仅在允许时才回显 Allow-Methods / Headers。
   */
  private applyCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin
    const bindHost = this.config.server.host
    const allow = isLoopbackHost(bindHost) && isAllowedOrigin(origin)
    if (allow && origin) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader(
        'Access-Control-Allow-Headers',
        'authorization,x-api-key,anthropic-version,content-type'
      )
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    }
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

  private bindClientAbort(
    req: IncomingMessage,
    res: ServerResponse,
    controller: AbortController
  ): () => void {
    const abort = (): void => {
      if (!controller.signal.aborted) controller.abort(new Error('Client aborted request'))
    }
    req.on('aborted', abort)
    res.on('close', abort)
    return () => {
      req.off('aborted', abort)
      res.off('close', abort)
    }
  }

  private async writeTracedResponse(
    req: IncomingMessage,
    res: ServerResponse,
    response: GatewayResponse,
    trace: RequestTrace
  ): Promise<void> {
    trace.statusCode = response.status
    trace.streaming = Boolean(response.stream)
    const headers = response.headers ?? { 'content-type': 'application/json; charset=utf-8' }
    res.writeHead(response.status, headers)

    if (response.stream) {
      // 流式响应可能跑得很久，关掉 socket idle 超时。
      req.setTimeout(0)
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

      const iterator = tracedStream[Symbol.asyncIterator]()
      // 客户端断连 / 主动 close：把上游 iterator 关掉，避免上游继续 yield、烧 token。
      let aborted = false
      const abort = (): void => {
        if (aborted) return
        aborted = true
        try {
          iterator.return?.(undefined)
        } catch {
          /* ignore */
        }
      }
      res.on('close', abort)
      req.on('aborted', abort)

      try {
        while (true) {
          const result = await iterator.next()
          if (result.done) break
          if (aborted) break
          const chunk = result.value
          // 背压：write 返回 false 时等到 'drain' 再继续，避免内存撑爆。
          if (!res.write(chunk)) {
            try {
              await once(res, 'drain')
            } catch {
              // socket 已关闭：跳出循环交给 'close' 处理。
              abort()
              break
            }
          }
        }
      } catch (error) {
        // headers 早已发送，只能在 SSE 通道里写一个错误事件，不能再切回 JSON 错误响应。
        const message = toErrorMessage(error)
        this.logger.error(`Stream failed: ${message}`, {
          requestId: trace.requestId,
          category: 'request',
          error: { stack: error instanceof Error ? error.stack : undefined }
        })
        try {
          if (!res.writableEnded) {
            res.write(sseData({ error: { message, code: 'stream_error' } }))
          }
        } catch {
          /* ignore */
        }
        abort()
      } finally {
        res.off('close', abort)
        req.off('aborted', abort)
        try {
          if (!res.writableEnded) res.end()
        } catch {
          /* ignore */
        }
      }
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
    req: IncomingMessage,
    res: ServerResponse,
    response: GatewayResponse
  ): Promise<void> {
    const headers = response.headers ?? { 'content-type': 'application/json; charset=utf-8' }
    res.writeHead(response.status, headers)
    if (response.stream) {
      req.setTimeout(0)
      const iterator = response.stream[Symbol.asyncIterator]()
      let aborted = false
      const abort = (): void => {
        if (aborted) return
        aborted = true
        try {
          iterator.return?.(undefined)
        } catch {
          /* ignore */
        }
      }
      res.on('close', abort)
      req.on('aborted', abort)
      try {
        while (true) {
          const result = await iterator.next()
          if (result.done) break
          if (aborted) break
          const chunk = result.value
          if (!res.write(chunk)) {
            try {
              await once(res, 'drain')
            } catch {
              abort()
              break
            }
          }
        }
      } finally {
        res.off('close', abort)
        req.off('aborted', abort)
        try {
          if (!res.writableEnded) res.end()
        } catch {
          /* ignore */
        }
      }
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
