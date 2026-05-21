import http from 'http'
import { gatewayHubService } from '../../main/gateway/service'

export interface InternalServerOptions {
  host: string
  port: number
  token: string
}

export function createInternalServer(opts: InternalServerOptions): http.Server {
  const server = http.createServer(async (req, res) => {
    const authToken = req.headers['x-gatewayhub-token']
    if (authToken !== opts.token) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    try {
      if (req.method === 'GET' && req.url === '/__internal/status') {
        const status = await gatewayHubService.getStatus()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(status))
        return
      }

      if (req.method === 'POST' && req.url === '/__internal/reload') {
        await (gatewayHubService as any).rebuildRuntime?.(
          (gatewayHubService as any).server?.running ?? false
        )
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      if (req.method === 'POST' && req.url === '/__internal/shutdown') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        // Graceful shutdown after response is sent
        setImmediate(async () => {
          try {
            await gatewayHubService.stop()
          } catch {
            /* ignore */
          }
          process.exit(0)
        })
        return
      }

      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    }
  })

  return server
}

export function startInternalServer(opts: InternalServerOptions): Promise<http.Server> {
  const server = createInternalServer(opts)
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(opts.port, opts.host, () => resolve(server))
  })
}
