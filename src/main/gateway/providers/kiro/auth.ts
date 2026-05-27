import { randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import { dirname, join } from 'path'
import { mkdir } from 'fs/promises'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { KiroAccountConfig, KiroProviderSettings } from '../../types'
import { apiUrl, awsSsoOidcUrl, kiroRefreshUrl, runtimeUrl } from './constants'
import {
  atomicWrite,
  expandHome,
  machineFingerprint,
  parseIsoDate,
  readJsonFile,
  toErrorMessage
} from '../../core/utils'

export type KiroAuthType = 'kiro_desktop' | 'aws_sso_oidc'

/** Kiro UA 中的 os/{platform} 段：darwin/linux/windows，其余原样透传 */
function osTokenForUserAgent(): string {
  const platform = process.platform
  if (platform === 'win32') return 'windows'
  return platform // darwin, linux, ...
}

/** 从错误正文/凭据正文中清掉 token-like 字符串，避免错误日志里写出真实凭据 */
function redactStringSecrets(text: string): string {
  if (!text) return ''
  // 长 base64/hex/JWT-ish 串
  let out = text.replace(/[A-Za-z0-9_-]{32,}/g, (match) =>
    match.length > 12 ? `${match.slice(0, 6)}…(redacted)` : match
  )
  // 显式 token 字段
  out = out.replace(
    /("(?:access|refresh|id)_token"\s*:\s*")[^"]+(")/gi,
    (_, p1, p2) => `${p1}***${p2}`
  )
  out = out.replace(
    /\b(access|refresh|bearer)\s*[:=]\s*[A-Za-z0-9._-]+/gi,
    (_, label: string) => `${label}=***`
  )
  return out
}

export class KiroAuthManager {
  readonly account: KiroAccountConfig
  readonly settings: KiroProviderSettings
  readonly fingerprint = machineFingerprint()

  private refreshToken = ''
  private accessToken = ''
  private expiresAt?: Date
  private profileArnValue = ''
  private clientId = ''
  private clientSecret = ''
  private ssoRegion = ''
  private apiRegion = ''
  private authTypeValue: KiroAuthType = 'kiro_desktop'
  /**
   * 单一 in-flight 刷新 Promise：getAccessToken 和 forceRefresh 共享去重，
   * 同一时刻最多只发一个刷新请求。
   */
  private refreshInFlight?: Promise<string>
  private accessOnly = false

  constructor(account: KiroAccountConfig, settings: KiroProviderSettings) {
    this.account = account
    this.settings = settings
    this.ssoRegion = account.region || settings.region || 'us-east-1'
    this.apiRegion = account.apiRegion || settings.apiRegion || this.ssoRegion
    this.profileArnValue = account.profileArn || ''
  }

  get authType(): KiroAuthType {
    return this.authTypeValue
  }

  get profileArn(): string {
    return this.profileArnValue
  }

  get expiresAtIso(): string | undefined {
    return this.expiresAt?.toISOString()
  }

  get apiHost(): string {
    return runtimeUrl(this.apiRegion || 'us-east-1')
  }

  get restApiHost(): string {
    return apiUrl(this.apiRegion || 'us-east-1')
  }

  /** noop dispose：accountPool reload 替换旧 auth 时调用，清掉 in-flight 刷新引用 */
  dispose(): void {
    this.refreshInFlight = undefined
  }

  async initialize(): Promise<void> {
    await this.loadFromJson()
    this.accessOnly = !this.refreshToken && !this.clientId
    this.authTypeValue = this.clientId && this.clientSecret ? 'aws_sso_oidc' : 'kiro_desktop'
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && !this.isExpiringSoon()) return this.accessToken
    if (this.accessOnly) {
      // 纯 access token 模式下不能刷新；过期就直接抛错，绝不返回过期 token
      if (this.isExpiringSoon()) {
        throw new Error('Access token expired (access-only mode). Please add a new access token.')
      }
      if (this.accessToken) return this.accessToken
      throw new Error('Access token is missing (access-only mode).')
    }
    return this.startRefresh()
  }

  async forceRefresh(): Promise<string> {
    if (this.accessOnly) {
      throw new Error('Access token is invalid or expired. Please add a new access token.')
    }
    return this.startRefresh()
  }

  private startRefresh(): Promise<string> {
    if (this.refreshInFlight) return this.refreshInFlight
    const promise = this.refreshAccessToken().finally(() => {
      // 仅清除自身引用（不能用 ===，但赋值 undefined 即可）
      if (this.refreshInFlight === promise) this.refreshInFlight = undefined
    })
    this.refreshInFlight = promise
    return promise
  }

  async ensureProfileArn(): Promise<void> {
    if (this.profileArnValue) return
    await this.loadKiroProfile()
  }

  async apiGet(path: string, params: Record<string, string>): Promise<any> {
    const url = new URL(path, this.restApiHost)
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))

    const doFetch = async (token: string) =>
      kiroFetch(
        url.toString(),
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': `aws-sdk-js/1.0.27 ua/2.1 os/${osTokenForUserAgent()} lang/js md/nodejs api/codewhispererruntime#1.0.27 m/E KiroIDE 1.0.0 ${this.fingerprint}`
          }
        },
        this.settings.vpnProxyUrl
      )

    let token = await this.getAccessToken()
    let resp = await doFetch(token)
    if (resp.status === 403) {
      token = await this.forceRefresh()
      resp = await doFetch(token)
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(
        `Kiro API ${path} failed: HTTP ${resp.status} ${redactStringSecrets(body.slice(0, 500))}`
      )
    }
    return resp.json()
  }

  buildHeaders(token: string): Record<string, string> {
    const os = osTokenForUserAgent()
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-amz-json-1.0',
      'x-amz-target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
      'User-Agent': `aws-sdk-js/1.0.27 ua/2.1 os/${os} lang/js md/nodejs api/codewhispererstreaming#1.0.27 m/E GatewayHub-0.1-${this.fingerprint}`,
      'x-amz-user-agent': `aws-sdk-js/1.0.27 GatewayHub-0.1-${this.fingerprint}`,
      'x-amzn-codewhisperer-optout': 'true',
      'x-amzn-kiro-agent-mode': 'vibe',
      'amz-sdk-invocation-id': randomUUID(),
      'amz-sdk-request': 'attempt=1; max=3'
    }
  }

  private async loadFromJson(): Promise<void> {
    this.refreshToken = this.account.refreshToken || ''
    this.accessToken = this.account.accessToken || ''
    this.profileArnValue = this.account.profileArn || this.profileArnValue
    this.clientId = this.account.clientId || ''
    this.clientSecret = this.account.clientSecret || ''
    if (this.account.expiresAt) this.expiresAt = parseIsoDate(this.account.expiresAt)

    if (this.account.path) {
      const path = expandHome(this.account.path)
      try {
        const data = await readJsonCredentials(path)
        if (!this.refreshToken) this.refreshToken = data.refreshToken || data.refresh_token || ''
        if (!this.accessToken) this.accessToken = data.accessToken || data.access_token || ''
        if (!this.profileArnValue) this.profileArnValue = data.profileArn || data.profile_arn || ''
        if (!this.clientId) this.clientId = data.clientId || data.client_id || ''
        if (!this.clientSecret) this.clientSecret = data.clientSecret || data.client_secret || ''
        if (!this.expiresAt) this.expiresAt = parseIsoDate(data.expiresAt || data.expires_at)
        if (data.region && !this.account.region) {
          this.ssoRegion = data.region
          this.apiRegion = this.account.apiRegion || this.settings.apiRegion || data.region
        }
      } catch {
        // File may not exist yet for newly created accounts
      }
    }

    if (!this.profileArnValue) await this.loadKiroProfile()
  }

  private async loadKiroProfile(): Promise<void> {
    const candidates = [
      join(
        process.env.HOME || process.env.USERPROFILE || '',
        'Library',
        'Application Support',
        'Kiro',
        'User',
        'globalStorage',
        'kiro.kiroagent',
        'profile.json'
      ),
      join(
        process.env.HOME || process.env.USERPROFILE || '',
        '.config',
        'Kiro',
        'User',
        'globalStorage',
        'kiro.kiroagent',
        'profile.json'
      )
    ]
    for (const path of candidates) {
      try {
        const data = await readJsonFile<any>(path)
        if (data?.arn) {
          this.profileArnValue = data.arn
          return
        }
      } catch {
        // Not found, try next.
      }
    }
  }

  private isExpiringSoon(): boolean {
    if (!this.expiresAt) return true
    return this.expiresAt.getTime() - Date.now() <= 10 * 60 * 1000
  }

  private async refreshAccessToken(): Promise<string> {
    if (this.accessOnly) {
      throw new Error('Access token expired. Please add a new access token.')
    }

    if (this.authTypeValue === 'aws_sso_oidc') await this.refreshAwsSsoOidc()
    else await this.refreshKiroDesktop()
    if (!this.accessToken) throw new Error('Failed to obtain Kiro access token')
    return this.accessToken
  }

  private async refreshKiroDesktop(): Promise<void> {
    if (!this.refreshToken) throw new Error('Kiro refresh token is missing')
    const response = await kiroFetch(
      kiroRefreshUrl(this.ssoRegion || 'us-east-1'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': `GatewayHub-0.1-${this.fingerprint}`
        },
        body: JSON.stringify({ refreshToken: this.refreshToken })
      },
      this.settings.vpnProxyUrl
    )
    if (!response.ok)
      throw new Error(
        `Kiro Desktop token refresh failed: HTTP ${response.status} ${await safeText(response)}`
      )
    const data = await response.json()
    this.accessToken = data.accessToken || data.access_token || ''
    this.refreshToken = data.refreshToken || data.refresh_token || this.refreshToken
    this.profileArnValue = data.profileArn || data.profile_arn || this.profileArnValue
    this.expiresAt = new Date(
      Date.now() + Math.max(60, Number(data.expiresIn || data.expires_in || 3600) - 60) * 1000
    )
    await this.persistCredentials()
  }

  private async refreshAwsSsoOidc(): Promise<void> {
    if (!this.refreshToken) throw new Error('AWS SSO refresh token is missing')
    if (!this.clientId || !this.clientSecret)
      throw new Error('AWS SSO clientId/clientSecret are missing')
    const response = await kiroFetch(
      awsSsoOidcUrl(this.ssoRegion || 'us-east-1'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grantType: 'refresh_token',
          clientId: this.clientId,
          clientSecret: this.clientSecret,
          refreshToken: this.refreshToken
        })
      },
      this.settings.vpnProxyUrl
    )
    if (!response.ok)
      throw new Error(
        `AWS SSO token refresh failed: HTTP ${response.status} ${await safeText(response)}`
      )
    const data = await response.json()
    this.accessToken = data.accessToken || ''
    this.refreshToken = data.refreshToken || this.refreshToken
    this.expiresAt = new Date(Date.now() + Math.max(60, Number(data.expiresIn || 3600) - 60) * 1000)
    await this.persistCredentials()
  }

  private async persistCredentials(): Promise<void> {
    if (!this.account.path) return
    const path = expandHome(this.account.path)
    try {
      await mkdir(dirname(path), { recursive: true })
      // 用 atomicWrite（lockfile + tmp + rename）保证跨进程并发刷新不丢 token
      const raw = await readFile(path, 'utf8').catch(() => '{}')
      const data = JSON.parse(raw || '{}')
      data.accessToken = this.accessToken
      data.refreshToken = this.refreshToken
      data.expiresAt = this.expiresAt?.toISOString()
      if (this.profileArnValue) data.profileArn = this.profileArnValue
      await atomicWrite(path, `${JSON.stringify(data, null, 2)}\n`)
    } catch (error) {
      console.warn(`Failed to persist Kiro credentials: ${toErrorMessage(error)}`)
    }
  }
}

/** 模块级 ProxyAgent 缓存：相同 proxy URL 复用同一个 dispatcher */
const proxyAgents = new Map<string, ProxyAgent>()

function getProxyAgent(proxyUrl: string): ProxyAgent {
  const normalized = proxyUrl.includes('://') ? proxyUrl : `http://${proxyUrl}`
  let agent = proxyAgents.get(normalized)
  if (!agent) {
    agent = new ProxyAgent(normalized)
    proxyAgents.set(normalized, agent)
  }
  return agent
}

export async function kiroFetch(
  url: string,
  init: RequestInit,
  proxyUrl?: string
): Promise<Response> {
  if (!proxyUrl) return fetch(url, init)
  try {
    const dispatcher = getProxyAgent(proxyUrl)
    return undiciFetch(url, { ...init, dispatcher } as Parameters<
      typeof undiciFetch
    >[1]) as unknown as Promise<Response>
  } catch (error) {
    throw new Error(`Kiro proxy setup failed for ${proxyUrl}: ${toErrorMessage(error)}`)
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return redactStringSecrets((await response.text()).slice(0, 1000))
  } catch {
    return ''
  }
}

async function readJsonCredentials(path: string): Promise<any> {
  try {
    return await readJsonFile<any>(path)
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        `Kiro credentials file not found: ${path}. Please log in again or remove this stale account.`
      )
    }
    throw error
  }
}
