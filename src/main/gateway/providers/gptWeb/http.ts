import { randomUUID } from 'crypto'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import {
  GPT_WEB_USER_AGENT,
  GPT_WEB_CLIENT_BUILD_NUMBER,
  GPT_WEB_CLIENT_VERSION,
  DEFAULT_GPT_WEB_BASE_URL,
  GPT_WEB_KNOWN_MODELS
} from './constants'
import type {
  SentinelPrepareResponse,
  SentinelFinalizeResponse,
  ConversationPrepareResponse
} from './types'
import { buildRequirementsToken, solveProofOfWork } from './sentinel'
import type { GptWebProviderSettings, GptWebAccountConfig } from '../../types'
import { fetchModelsViaNodeBridge, shouldUseNodeBridge } from './nodeBridge'

/** Module-level ProxyAgent cache: reuse same dispatcher for same proxy URL */
const proxyAgentCache = new Map<string, InstanceType<typeof ProxyAgent>>()

function getProxyAgent(proxyUrl: string): InstanceType<typeof ProxyAgent> {
  const normalized = proxyUrl.includes('://') ? proxyUrl : `http://${proxyUrl}`
  let agent = proxyAgentCache.get(normalized)
  if (!agent) {
    agent = new ProxyAgent(normalized)
    proxyAgentCache.set(normalized, agent)
  }
  return agent
}

async function proxyFetch(url: string, init: RequestInit, proxyUrl?: string): Promise<Response> {
  if (!proxyUrl) return fetch(url, init)
  const dispatcher = getProxyAgent(proxyUrl)
  return undiciFetch(url, { ...init, dispatcher } as any) as unknown as Response
}

export interface GptWebRequestContext {
  account: GptWebAccountConfig
  settings: GptWebProviderSettings
  signal?: AbortSignal
}

function buildHeaders(
  account: GptWebAccountConfig,
  settings: GptWebProviderSettings,
  cookieHeader?: string
): Record<string, string> {
  const origin = buildOrigin(settings)
  return {
    authorization: `Bearer ${account.accessToken}`,
    'oai-device-id': account.oaiDeviceId,
    'oai-language': 'en-US',
    'oai-client-build-number': GPT_WEB_CLIENT_BUILD_NUMBER,
    'oai-client-version': GPT_WEB_CLIENT_VERSION,
    // ChatGPT Web backend expects this literal header name.  The provider is
    // branded as gptWeb inside GatewayHub, but the upstream contract is still
    // chatgpt-account-id.
    'chatgpt-account-id': account.accountId,
    'content-type': 'application/json',
    'user-agent': GPT_WEB_USER_AGENT,
    'oai-session-id': randomUUID(),
    origin,
    referer: `${origin}/`,
    ...(cookieHeader ? { cookie: cookieHeader } : {})
  }
}

function buildUrl(settings: GptWebProviderSettings, path: string): string {
  const base = settings.baseUrl || DEFAULT_GPT_WEB_BASE_URL
  return `${base}${path}`
}

function buildOrigin(settings: GptWebProviderSettings): string {
  const base = settings.baseUrl || DEFAULT_GPT_WEB_BASE_URL
  return new URL(base.replace('/backend-api', '')).origin
}

export interface SentinelTokens {
  chatRequirementsToken?: string
  proofToken?: string
  turnstileToken?: string
  cookieHeader?: string
}

export async function fetchSentinelTokens(ctx: GptWebRequestContext): Promise<SentinelTokens> {
  const { account, settings, signal } = ctx

  const requirementsToken = buildRequirementsToken()
  const headers = buildHeaders(account, settings)
  const prepareBody = { p: requirementsToken }

  const prepareRes = await proxyFetch(
    buildUrl(settings, '/sentinel/chat-requirements/prepare'),
    {
      method: 'POST',
      headers,
      body: JSON.stringify(prepareBody),
      signal
    },
    settings.vpnProxyUrl
  )

  if (!prepareRes.ok) return {}

  const prepare: SentinelPrepareResponse = await prepareRes.json()
  let proofToken: string | undefined
  if (prepare.proofofwork?.required && prepare.proofofwork.seed) {
    proofToken = solveProofOfWork({
      seed: prepare.proofofwork.seed,
      difficulty: prepare.proofofwork.difficulty
    })
  }

  const finalizeBody: Record<string, unknown> = { prepare_token: prepare.prepare_token }
  if (proofToken) finalizeBody.proofofwork = proofToken

  const finalizeRes = await proxyFetch(
    buildUrl(settings, '/sentinel/chat-requirements/finalize'),
    {
      method: 'POST',
      headers: buildHeaders(account, settings),
      body: JSON.stringify(finalizeBody),
      signal
    },
    settings.vpnProxyUrl
  )

  if (!finalizeRes.ok) return { proofToken }

  const finalize: SentinelFinalizeResponse = await finalizeRes.json()
  return { chatRequirementsToken: finalize.token, proofToken }
}

export async function fetchConduitToken(
  ctx: GptWebRequestContext,
  body: Record<string, unknown>,
  sentinelTokens?: SentinelTokens
): Promise<string | undefined> {
  const { account, settings, signal } = ctx
  const headers = buildHeaders(account, settings, sentinelTokens?.cookieHeader)
  applySentinelHeaders(headers, sentinelTokens)

  const res = await proxyFetch(
    buildUrl(settings, '/f/conversation/prepare'),
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal
    },
    settings.vpnProxyUrl
  )

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`GptWeb conduit prepare error ${res.status}: ${text.slice(0, 200)}`)
  }

  const data: ConversationPrepareResponse = await res.json()
  return data.conduit_token
}

export async function* streamConversation(
  ctx: GptWebRequestContext,
  body: Record<string, unknown>,
  sentinelTokens?: SentinelTokens,
  conduitToken?: string
): AsyncGenerator<string> {
  const { account, settings, signal } = ctx
  const headers: Record<string, string> = {
    ...buildHeaders(account, settings, sentinelTokens?.cookieHeader),
    accept: 'text/event-stream',
    'x-openai-target-path': '/backend-api/f/conversation',
    'x-openai-target-route': '/backend-api/f/conversation'
  }

  applySentinelHeaders(headers, sentinelTokens)
  if (conduitToken) {
    headers['x-conduit-token'] = conduitToken
  }

  const res = await proxyFetch(
    buildUrl(settings, '/f/conversation'),
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal
    },
    settings.vpnProxyUrl
  )

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`GptWeb API error ${res.status}: ${text.slice(0, 200)}`)
  }

  if (!res.body) throw new Error('No response body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (line.trim()) yield line
      }
    }
    if (buffer.trim()) yield buffer
  } finally {
    reader.releaseLock()
  }
}

export async function fetchModels(ctx: GptWebRequestContext): Promise<string[]> {
  if (shouldUseNodeBridge()) return fetchModelsViaNodeBridge(ctx)

  const { account, settings, signal } = ctx
  const headers = buildHeaders(account, settings)

  const res = await proxyFetch(
    buildUrl(settings, '/models?iim=false&is_gizmo=false'),
    {
      method: 'GET',
      headers,
      signal
    },
    settings.vpnProxyUrl
  )

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GptWeb models error ${res.status}: ${body.slice(0, 200)}`)
  }

  const data = await res.json()
  if (data?.models && Array.isArray(data.models)) {
    const modelIds = normalizeModelIds(
      data.models.map((m: { slug?: string }) => m.slug).filter(Boolean)
    )
    if ((account.planType || 'free') === 'free') {
      const knownUsable = new Set(GPT_WEB_KNOWN_MODELS)
      return modelIds.filter((id) => knownUsable.has(id))
    }
    return modelIds
  }
  throw new Error('GptWeb models response missing models array')
}

function applySentinelHeaders(
  headers: Record<string, string>,
  sentinelTokens?: SentinelTokens
): void {
  if (sentinelTokens?.chatRequirementsToken) {
    headers['openai-sentinel-chat-requirements-token'] = sentinelTokens.chatRequirementsToken
  }
  if (sentinelTokens?.proofToken) {
    headers['openai-sentinel-proof-token'] = sentinelTokens.proofToken
  }
  if (sentinelTokens?.turnstileToken) {
    headers['openai-sentinel-turnstile-token'] = sentinelTokens.turnstileToken
  }
}

function normalizeModelIds(modelIds: string[]): string[] {
  const seen = new Set<string>()
  for (const id of modelIds) {
    const trimmed = String(id || '').trim()
    if (trimmed) seen.add(trimmed)
  }
  seen.add('auto')
  return [...seen]
}
