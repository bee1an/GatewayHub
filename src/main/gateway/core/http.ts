import { timingSafeEqual } from 'crypto'

/** 默认请求体上限：8 MiB（参考 GatewayHub HTTP 入口的硬性限制）。 */
export const MAX_BODY_BYTES = 8 * 1024 * 1024

/** 读取请求头/请求体阶段允许的最长 socket 空闲时间，超过后回 408。 */
export const HEAD_TIMEOUT_MS = 15_000

/** 显式的 server 超时配置（避免慢攻击）。 */
export const HEADERS_TIMEOUT_MS = 15_000
export const KEEP_ALIVE_TIMEOUT_MS = 30_000

/** stop() 调用 closeAllConnections() 之前的兜底等待时间。 */
export const STOP_FORCE_CLOSE_MS = 5_000

/**
 * 常量时间字符串比较，避免 timing oracle 推断 API key 长度/前缀。
 * 长度不一致直接返回 false（即便 timingSafeEqual 自身也会抛错）。
 */
export function safeEqualString(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length === 0 || b.length === 0) return false
  if (a.length !== b.length) return false
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/** 判断 host 是否绑定到回环地址（127.0.0.1 / ::1 / localhost）。 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false
  const h = host.toLowerCase().trim()
  return h === '127.0.0.1' || h === '::1' || h === 'localhost'
}

/**
 * 解析 `Host` 请求头，校验是否为允许的回环主机。
 * 用于阻挡 DNS rebinding：当服务器只听回环时，必须收到回环的 Host。
 *
 * 接受形式：
 *   - 127.0.0.1 / 127.0.0.1:PORT
 *   - localhost / localhost:PORT
 *   - [::1] / [::1]:PORT
 */
export function isAllowedHostHeader(hostHeader: string | undefined, expectedPort: number): boolean {
  if (!hostHeader) return false
  const lower = hostHeader.toLowerCase().trim()
  if (!lower) return false

  let hostPart = lower
  let portPart = ''
  if (lower.startsWith('[')) {
    const close = lower.indexOf(']')
    if (close < 0) return false
    hostPart = lower.slice(1, close)
    if (lower.length > close + 1) {
      if (lower[close + 1] !== ':') return false
      portPart = lower.slice(close + 2)
    }
  } else {
    const colon = lower.indexOf(':')
    if (colon >= 0) {
      hostPart = lower.slice(0, colon)
      portPart = lower.slice(colon + 1)
    }
  }

  if (portPart) {
    if (!/^\d+$/.test(portPart)) return false
    if (Number(portPart) !== expectedPort) return false
  }
  return hostPart === '127.0.0.1' || hostPart === '::1' || hostPart === 'localhost'
}

const ALLOWED_ORIGIN_PATTERNS: RegExp[] = [
  /^http:\/\/localhost(:\d+)?$/i,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/i,
  /^http:\/\/\[::1\](:\d+)?$/i,
  /^file:\/\//i,
  /^app:\/\//i,
  /^vscode-webview:\/\//i
]

/**
 * 判断 Origin 是否属于本地客户端白名单。
 * 仅在服务器绑定回环时使用：白名单内的 Origin 才回显 ACAO。
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false
  return ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin))
}
