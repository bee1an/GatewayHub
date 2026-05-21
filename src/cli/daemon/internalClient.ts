import http from 'http'

export interface InternalClientOptions {
  host: string
  port: number
  token: string
  timeout?: number
}

export async function internalGet(
  path: string,
  opts: InternalClientOptions
): Promise<{ status: number; body: any }> {
  return internalRequest('GET', path, opts)
}

export async function internalPost(
  path: string,
  opts: InternalClientOptions,
  body?: unknown
): Promise<{ status: number; body: any }> {
  return internalRequest('POST', path, opts, body)
}

function internalRequest(
  method: string,
  path: string,
  opts: InternalClientOptions,
  body?: unknown
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined
    const req = http.request(
      {
        hostname: opts.host,
        port: opts.port,
        path,
        method,
        headers: {
          'x-gatewayhub-token': opts.token,
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {})
        },
        timeout: opts.timeout ?? 5000
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: any
          try {
            parsed = JSON.parse(text)
          } catch {
            parsed = text
          }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Internal request timed out'))
    })
    if (payload) req.write(payload)
    req.end()
  })
}
