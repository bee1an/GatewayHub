import { createServer, type Server } from 'http'
import { shell } from 'electron'
import { randomBytes } from 'crypto'
import type { CodexProviderSettings } from '../../types'
import { toErrorMessage } from '../../core/utils'
import { codexFetch } from './auth'
import {
  OPENAI_AUTHORIZE_URL,
  OPENAI_DEVICE_CODE_URL,
  OPENAI_DEVICE_REDIRECT_URI,
  OPENAI_DEVICE_TOKEN_URL,
  OPENAI_DEVICE_VERIFICATION_URL,
  OPENAI_OAUTH_CLIENT_ID,
  OPENAI_OAUTH_SCOPE,
  OPENAI_TOKEN_URL
} from './constants'
import {
  buildAuthPayloadFromTokenResponse,
  buildCodexAccountFromAuth,
  createPkceChallenge,
  createPkceVerifier
} from './normalize'
import type { CodexDeviceCodeResponse, CodexLoginEvent, CodexTokenResponse } from './types'
import type { CodexAccountConfig } from '../../types'

export type LoginEventListener = (event: CodexLoginEvent) => void

interface BrowserLoginContext {
  server: Server
  port: number
  state: string
  verifier: string
  resolved: boolean
  cancelled: boolean
}

interface DeviceLoginContext {
  cancelled: boolean
  pollAbort: AbortController
}

let activeBrowserLogin: BrowserLoginContext | undefined
let activeDeviceLogin: DeviceLoginContext | undefined
let onAccountImported: ((account: CodexAccountConfig) => Promise<void> | void) | undefined

export function setOnCodexAccountImported(
  listener: (account: CodexAccountConfig) => Promise<void> | void
): void {
  onAccountImported = listener
}

/** 启动 PKCE 浏览器登录 */
export async function loginCodexWithBrowser(
  settings: CodexProviderSettings,
  emit: LoginEventListener
): Promise<void> {
  if (activeBrowserLogin && !activeBrowserLogin.resolved) {
    throw new Error('A Codex browser login is already in progress')
  }
  await cancelDeviceLoginIfActive()

  const verifier = createPkceVerifier()
  const challenge = createPkceChallenge(verifier)
  const state = randomBytes(16).toString('base64url')
  const port = settings.callbackPort || 1455
  const redirectUri = `http://localhost:${port}/auth/callback`

  const ctx: BrowserLoginContext = {
    server: createServer(),
    port,
    state,
    verifier,
    resolved: false,
    cancelled: false
  }
  activeBrowserLogin = ctx

  const cleanup = (): void => {
    ctx.resolved = true
    ctx.server.close(() => {})
    if (activeBrowserLogin === ctx) activeBrowserLogin = undefined
  }

  const handleSuccess = async (account: CodexAccountConfig): Promise<void> => {
    if (onAccountImported) await onAccountImported(account)
    emit({ kind: 'success', accountId: account.id })
    cleanup()
  }

  const handleError = (error: unknown): void => {
    emit({ kind: 'error', message: toErrorMessage(error) })
    cleanup()
  }

  ctx.server.on('request', (req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)
        if (url.pathname !== '/auth/callback') {
          res.writeHead(404).end('Not found')
          return
        }
        const code = url.searchParams.get('code')
        const returnedState = url.searchParams.get('state')
        if (!code || returnedState !== state) {
          res.writeHead(400).end('Invalid OAuth callback')
          handleError(new Error('OAuth state mismatch'))
          return
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(loginSuccessHtml())
        const tokens = await exchangeAuthorizationCode(
          code,
          redirectUri,
          verifier,
          settings.vpnProxyUrl
        )
        const account = buildCodexAccountFromAuth(buildAuthPayloadFromTokenResponse(tokens))
        if (!account) throw new Error('Failed to derive Codex account from token response')
        await handleSuccess(account)
      } catch (error) {
        handleError(error)
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    const onListenError = (err: Error): void => {
      cleanup()
      reject(err)
    }
    ctx.server.once('error', onListenError)
    ctx.server.listen(port, '127.0.0.1', () => {
      ctx.server.off('error', onListenError)
      resolve()
    })
  })

  const authorizeUrl = buildAuthorizeUrl(challenge, state, redirectUri)
  emit({ kind: 'authorize', authorizeUrl, message: 'Browser launched' })
  try {
    await shell.openExternal(authorizeUrl)
  } catch {
    // 打开失败也不要紧，前端可以显示链接给用户手动点
  }
}

export async function cancelCodexBrowserLogin(): Promise<boolean> {
  const ctx = activeBrowserLogin
  if (!ctx || ctx.resolved) return false
  ctx.cancelled = true
  ctx.resolved = true
  ctx.server.close(() => {})
  activeBrowserLogin = undefined
  return true
}

/** 启动设备流登录（headless 场景） */
export async function loginCodexWithDevice(
  settings: CodexProviderSettings,
  emit: LoginEventListener
): Promise<void> {
  if (activeDeviceLogin && !activeDeviceLogin.cancelled) {
    throw new Error('A Codex device login is already in progress')
  }
  await cancelBrowserLoginIfActive()

  const ctx: DeviceLoginContext = {
    cancelled: false,
    pollAbort: new AbortController()
  }
  activeDeviceLogin = ctx

  const cleanup = (): void => {
    if (activeDeviceLogin === ctx) activeDeviceLogin = undefined
  }

  try {
    const code = await requestDeviceCode(settings.vpnProxyUrl)
    emit({
      kind: 'authorize',
      message: 'Open the verification URL on any device and enter the user code',
      authorizeUrl: OPENAI_DEVICE_VERIFICATION_URL,
      userCode: code.user_code,
      verificationUri: OPENAI_DEVICE_VERIFICATION_URL
    })
    const intermediate = await pollDeviceAuthorization(
      code,
      settings.vpnProxyUrl,
      ctx.pollAbort.signal
    )
    if (ctx.cancelled) {
      emit({ kind: 'cancelled' })
      return
    }
    const tokens = await exchangeDeviceAuthorizationCode(
      intermediate.authorization_code,
      intermediate.code_verifier,
      settings.vpnProxyUrl
    )
    if (ctx.cancelled) {
      emit({ kind: 'cancelled' })
      return
    }
    const account = buildCodexAccountFromAuth(buildAuthPayloadFromTokenResponse(tokens))
    if (!account) throw new Error('Failed to derive Codex account from token response')
    if (onAccountImported) await onAccountImported(account)
    emit({ kind: 'success', accountId: account.id })
  } catch (error) {
    if (ctx.cancelled) emit({ kind: 'cancelled' })
    else emit({ kind: 'error', message: toErrorMessage(error) })
  } finally {
    cleanup()
  }
}

export async function cancelCodexDeviceLogin(): Promise<boolean> {
  const ctx = activeDeviceLogin
  if (!ctx || ctx.cancelled) return false
  ctx.cancelled = true
  ctx.pollAbort.abort()
  return true
}

async function cancelBrowserLoginIfActive(): Promise<void> {
  if (activeBrowserLogin && !activeBrowserLogin.resolved) {
    await cancelCodexBrowserLogin()
  }
}

async function cancelDeviceLoginIfActive(): Promise<void> {
  if (activeDeviceLogin && !activeDeviceLogin.cancelled) {
    await cancelCodexDeviceLogin()
  }
}

function buildAuthorizeUrl(challenge: string, state: string, redirectUri: string): string {
  const url = new URL(OPENAI_AUTHORIZE_URL)
  url.searchParams.set('client_id', OPENAI_OAUTH_CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', OPENAI_OAUTH_SCOPE)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('originator', 'Codex Desktop')
  return url.toString()
}

async function exchangeAuthorizationCode(
  code: string,
  redirectUri: string,
  verifier: string,
  proxyUrl?: string
): Promise<CodexTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: OPENAI_OAUTH_CLIENT_ID,
    code_verifier: verifier
  }).toString()
  const response = await codexFetch(
    OPENAI_TOKEN_URL,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body
    },
    proxyUrl
  )
  if (!response.ok) {
    throw new Error(
      `Codex token exchange failed: HTTP ${response.status} ${(await safeText(response)).slice(
        0,
        500
      )}`
    )
  }
  return (await response.json()) as CodexTokenResponse
}

async function requestDeviceCode(proxyUrl?: string): Promise<CodexDeviceCodeResponse> {
  const response = await codexFetch(
    OPENAI_DEVICE_CODE_URL,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: OPENAI_OAUTH_CLIENT_ID })
    },
    proxyUrl
  )
  if (!response.ok) {
    throw new Error(
      `Codex device code request failed: HTTP ${response.status} ${(await safeText(response)).slice(
        0,
        500
      )}`
    )
  }
  return (await response.json()) as CodexDeviceCodeResponse
}

/**
 * 设备流：先轮询 deviceauth/token 拿到 authorization_code + code_verifier，
 * 再走 oauth/token 用 form-urlencoded 换成正式 access/refresh/id token
 */
async function pollDeviceAuthorization(
  code: CodexDeviceCodeResponse,
  proxyUrl: string | undefined,
  signal: AbortSignal
): Promise<{ authorization_code: string; code_verifier: string }> {
  const intervalSeconds = Math.max(1, code.interval ?? 5)
  while (!signal.aborted) {
    const response = await codexFetch(
      OPENAI_DEVICE_TOKEN_URL,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          device_auth_id: code.device_auth_id,
          user_code: code.user_code
        })
      },
      proxyUrl
    )
    const raw = await safeText(response)
    if (response.ok) {
      const parsed = JSON.parse(raw) as { authorization_code?: string; code_verifier?: string }
      if (!parsed.authorization_code || !parsed.code_verifier) {
        throw new Error('Codex device token response missing authorization_code/code_verifier')
      }
      return {
        authorization_code: parsed.authorization_code,
        code_verifier: parsed.code_verifier
      }
    }
    if ([400, 403, 404, 428].includes(response.status)) {
      // 用户尚未确认，继续等待
      await sleep(intervalSeconds * 1000, signal)
      continue
    }
    throw new Error(`Codex device token poll failed: HTTP ${response.status} ${raw.slice(0, 500)}`)
  }
  throw new Error('Device login cancelled')
}

async function exchangeDeviceAuthorizationCode(
  authorizationCode: string,
  codeVerifier: string,
  proxyUrl?: string
): Promise<CodexTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: authorizationCode,
    redirect_uri: OPENAI_DEVICE_REDIRECT_URI,
    client_id: OPENAI_OAUTH_CLIENT_ID,
    code_verifier: codeVerifier
  }).toString()
  const response = await codexFetch(
    OPENAI_TOKEN_URL,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body
    },
    proxyUrl
  )
  if (!response.ok) {
    throw new Error(
      `Codex device token exchange failed: HTTP ${response.status} ${(
        await safeText(response)
      ).slice(0, 500)}`
    )
  }
  return (await response.json()) as CodexTokenResponse
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const t = setTimeout(() => resolve(), ms)
    if (signal) {
      const onAbort = (): void => {
        clearTimeout(t)
        reject(new Error('aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 1000)
  } catch {
    return ''
  }
}

function loginSuccessHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Codex login</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#0b0d10;color:#fff;margin:0}
.box{text-align:center;padding:32px 48px;border-radius:12px;background:#161b22;box-shadow:0 8px 32px rgba(0,0,0,0.4)}
h1{margin:0 0 8px;font-size:18px}p{margin:0;color:#9aa6b2;font-size:13px}</style></head>
<body><div class="box"><h1>Codex login successful</h1><p>You can now close this tab and return to GatewayHub.</p></div></body></html>`
}
