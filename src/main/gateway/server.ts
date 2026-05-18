import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { GatewayHubConfig, GatewayResponse } from './types'
import { GatewayLogger } from './core/logger'
import { parseRequestBody, requestId, toErrorMessage } from './core/utils'
import { ProviderRegistry } from './providerRegistry'

export class GatewayServer {
  private server?: Server

  constructor(
    private readonly config: GatewayHubConfig,
    private readonly registry: ProviderRegistry,
    private readonly logger: GatewayLogger
  ) {}

  get running(): boolean {
    return Boolean(this.server?.listening)
  }

  get url(): string {
    return `http://${this.config.server.host}:${this.config.server.port}`
  }

  async start(): Promise<void> {
    if (this.running) return
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      this.server!.once('error', onError)
      this.server!.listen(this.config.server.port, this.config.server.host, () => {
        this.server!.off('error', onError)
        resolve()
      })
    })
    this.logger.info(`Gateway server listening on ${this.url}`)
  }

  async stop(): Promise<void> {
    if (!this.server) return
    const server = this.server
    this.server = undefined
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    this.logger.info('Gateway server stopped')
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
        return this.writeJson(res, 401, { error: { message: 'Invalid or missing API key', type: 'authentication_error' } })
      }

      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const models = await this.registry.listModels()
        return this.writeJson(res, 200, {
          object: 'list',
          data: models.map((model) => ({ id: model.id, object: 'model', created: 0, owned_by: model.ownedBy || model.provider, description: model.description }))
        })
      }

      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await parseRequestBody(req)
        return this.writeGatewayResponse(res, await this.registry.chatCompletions(body, { requestId: rid, apiFormat: 'openai' }))
      }

      if (req.method === 'POST' && url.pathname === '/v1/messages') {
        const body = await parseRequestBody(req)
        return this.writeGatewayResponse(res, await this.registry.messages(body, { requestId: rid, apiFormat: 'anthropic' }))
      }

      if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
        const body = await parseRequestBody(req)
        return this.writeGatewayResponse(res, await this.registry.countTokens(body, { requestId: rid, apiFormat: 'anthropic' }))
      }

      return this.writeJson(res, 404, { error: { message: `Not found: ${url.pathname}`, type: 'not_found' } })
    } catch (error) {
      this.logger.error(`HTTP request failed: ${toErrorMessage(error)}`)
      return this.writeJson(res, 500, { error: { message: toErrorMessage(error), type: 'gateway_error' } })
    }
  }

  private verifyApiKey(req: IncomingMessage): boolean {
    const expected = this.config.server.apiKey
    if (!expected) return true
    const auth = req.headers.authorization
    const xApiKey = req.headers['x-api-key']
    return auth === `Bearer ${expected}` || xApiKey === expected
  }

  private async writeGatewayResponse(res: ServerResponse, response: GatewayResponse): Promise<void> {
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
}

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'authorization,x-api-key,anthropic-version,content-type')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
}
