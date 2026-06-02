import { randomUUID } from 'crypto'
import { ProxyAgent, WebSocket, fetch as undiciFetch } from 'undici'
import type { GrokWebAccountConfig, GrokWebProviderSettings } from '../../types'
import {
  DEFAULT_GROK_WEB_BASE_URL,
  DEFAULT_GROK_WEB_WS_URL,
  GROK_WEB_KNOWN_MODELS,
  GROK_WEB_USER_AGENT
} from './constants'
import type {
  GrokGatewayEvent,
  GrokWebModesResponse,
  GrokWebModelsResponse,
  GrokWebUser
} from './types'

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

export interface GrokWebRequestContext {
  account: GrokWebAccountConfig
  settings: GrokWebProviderSettings
  signal?: AbortSignal
}

export interface GrokConversationInput {
  model: string
  prompt: string
  parentResponseId?: string
}

export async function fetchUser(ctx: GrokWebRequestContext): Promise<GrokWebUser> {
  const { settings, signal } = ctx
  const res = await proxyFetch(
    buildRestUrl(settings, '/rest/auth/get-user'),
    {
      method: 'GET',
      headers: buildHeaders(ctx, false),
      signal
    },
    settings.vpnProxyUrl
  )

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Grok Web user error ${res.status}: ${body.slice(0, 200)}`)
  }

  const data = (await res.json()) as any
  return (data?.user && typeof data.user === 'object' ? data.user : data) as GrokWebUser
}

export async function fetchModels(ctx: GrokWebRequestContext): Promise<string[]> {
  const modes = await fetchModes(ctx).catch(() => [])
  if (modes.length) return normalizeModelIds(modes)

  const { settings, signal } = ctx
  const res = await proxyFetch(
    buildRestUrl(settings, '/rest/models'),
    {
      method: 'POST',
      headers: buildHeaders(ctx, true),
      body: JSON.stringify({ locale: 'en' }),
      signal
    },
    settings.vpnProxyUrl
  )

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Grok Web models error ${res.status}: ${body.slice(0, 200)}`)
  }

  const data = (await res.json()) as GrokWebModelsResponse
  return normalizeModelIds([
    data.defaultFreeMode,
    data.defaultFreeModel,
    ...(data.models ?? []).map((model) => model.modelId || model.name || model.modeName)
  ])
}

export async function fetchModes(ctx: GrokWebRequestContext): Promise<string[]> {
  const { settings, signal } = ctx
  const res = await proxyFetch(
    buildRestUrl(settings, '/rest/modes'),
    {
      method: 'POST',
      headers: buildHeaders(ctx, true),
      body: JSON.stringify({ locale: 'en' }),
      signal
    },
    settings.vpnProxyUrl
  )

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Grok Web modes error ${res.status}: ${body.slice(0, 200)}`)
  }

  const data = (await res.json()) as GrokWebModesResponse
  return normalizeModelIds([
    data.defaultModeId,
    ...(data.modes ?? [])
      .filter((mode) => mode.availability?.available !== false)
      .map((mode) => mode.id)
  ])
}

export async function* streamGrokConversation(
  ctx: GrokWebRequestContext,
  input: GrokConversationInput
): AsyncGenerator<GrokGatewayEvent> {
  const { account, settings } = ctx
  const dispatcher = settings.vpnProxyUrl ? getProxyAgent(settings.vpnProxyUrl) : undefined
  const ws = new WebSocket(buildWsUrl(settings, account), {
    headers: buildHeaders(ctx, false),
    dispatcher
  } as any) as any

  const queue: GrokGatewayEvent[] = []
  const waiters: Array<() => void> = []
  let closed = false
  let closeReason = ''
  let failed: Error | undefined
  let turnSent = false
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const notify = (): void => {
    while (waiters.length) waiters.shift()?.()
  }
  const enqueue = (event: GrokGatewayEvent): void => {
    queue.push(event)
    notify()
  }
  const fail = (error: Error): void => {
    failed = error
    notify()
  }

  ws.addEventListener('open', () => {
    ws.send(
      JSON.stringify({
        type: 'session.create',
        event_id: 'evt_init',
        session: buildSession(input.model)
      })
    )
  })
  ws.addEventListener('message', (event: { data: unknown }) => {
    void readWebSocketData(event.data)
      .then((text) => {
        if (!text) return
        let parsed: GrokGatewayEvent
        try {
          parsed = JSON.parse(text) as GrokGatewayEvent
        } catch {
          return
        }
        if (parsed.type === 'pong') return
        enqueue(parsed)
      })
      .catch((error) => fail(error instanceof Error ? error : new Error(String(error))))
  })
  ws.addEventListener('error', () => {
    fail(new Error('Grok WebSocket error'))
  })
  ws.addEventListener('close', (event: { code?: number; reason?: string }) => {
    closed = true
    closeReason = event.reason || (event.code ? `close ${event.code}` : 'closed')
    notify()
  })

  const cleanup = (): void => {
    if (heartbeat) clearInterval(heartbeat)
    try {
      ws.close()
    } catch {
      // ignore
    }
  }

  try {
    let sawFirstContent = false
    while (true) {
      const timeoutMs =
        (sawFirstContent
          ? settings.streamingReadTimeoutSeconds
          : settings.firstTokenTimeoutSeconds) * 1000
      const event = await nextEvent(timeoutMs)

      if (event.type === 'session.created' && !turnSent) {
        turnSent = true
        sendTurn(ws, input)
        heartbeat = setInterval(() => {
          try {
            ws.send(JSON.stringify({ type: 'ping', event_id: `evt_hb_${Date.now()}` }))
          } catch {
            // ignore; close/error handler will surface failure
          }
        }, 1500)
      }

      if (event.type === 'response.output_text.delta' && event.delta) sawFirstContent = true
      yield event
      if (event.type === 'response.done' || event.type === 'error') return
    }
  } finally {
    cleanup()
  }

  async function nextEvent(timeoutMs: number): Promise<GrokGatewayEvent> {
    if (queue.length) return queue.shift()!
    if (failed) throw failed
    if (closed) throw new Error(`Grok WebSocket closed before response completed: ${closeReason}`)

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          const idx = waiters.indexOf(onReady)
          if (idx >= 0) waiters.splice(idx, 1)
          reject(new Error('Grok WebSocket timed out'))
        },
        Math.max(1000, timeoutMs || 30_000)
      )
      const onReady = (): void => {
        clearTimeout(timer)
        resolve()
      }
      waiters.push(onReady)
    })

    if (queue.length) return queue.shift()!
    if (failed) throw failed
    if (closed) throw new Error(`Grok WebSocket closed before response completed: ${closeReason}`)
    throw new Error('Grok WebSocket produced no event')
  }
}

function sendTurn(ws: { send(data: string): void }, input: GrokConversationInput): void {
  const now = Date.now()
  ws.send(
    JSON.stringify({
      type: 'conversation.item.create',
      event_id: `evt_action_${now}`,
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: input.prompt }],
        x_grok: { client_message_id: randomUUID() }
      },
      ...(input.parentResponseId ? { parent_response_id: input.parentResponseId } : {})
    })
  )
  ws.send(JSON.stringify({ type: 'response.create', event_id: `evt_resp_${now}` }))
}

function buildSession(model: string): Record<string, unknown> {
  return {
    model: model || 'auto',
    x_grok: {
      keep_context: false,
      is_temporary: true,
      enable_image_generation: true,
      image_generation_count: 1,
      disable_text_follow_ups: false,
      supported_fast_tools: { calculatorTool: '1', unitConversionTool: '1' },
      disable_artifact: true,
      force_concise: false,
      enable_side_by_side: true
    }
  }
}

function buildHeaders(ctx: GrokWebRequestContext, json: boolean): Record<string, string> {
  const origin = buildOrigin(ctx.settings)
  return {
    accept: json ? 'application/json, text/plain, */*' : '*/*',
    ...(json ? { 'content-type': 'application/json' } : {}),
    'accept-language': 'en-US,en;q=0.9',
    'user-agent': GROK_WEB_USER_AGENT,
    origin,
    referer: `${origin}/`,
    cookie: ctx.account.cookieHeader
  }
}

function buildRestUrl(settings: GrokWebProviderSettings, path: string): string {
  const base = (settings.baseUrl || DEFAULT_GROK_WEB_BASE_URL).replace(/\/+$/, '')
  return `${base}${path}`
}

function buildWsUrl(settings: GrokWebProviderSettings, account: GrokWebAccountConfig): string {
  const base = settings.wsUrl || DEFAULT_GROK_WEB_WS_URL
  const uid = account.userId || extractCookieValue(account.cookieHeader, 'x-userid')
  if (!uid) return base
  const joiner = base.includes('?') ? '&' : '?'
  return `${base}${joiner}uid=${encodeURIComponent(uid)}`
}

function buildOrigin(settings: GrokWebProviderSettings): string {
  return new URL(settings.baseUrl || DEFAULT_GROK_WEB_BASE_URL).origin
}

function normalizeModelIds(modelIds: Array<unknown>): string[] {
  const seen = new Set<string>()
  for (const id of GROK_WEB_KNOWN_MODELS) seen.add(id)
  for (const id of modelIds) {
    const trimmed = String(id || '').trim()
    if (trimmed) seen.add(trimmed)
  }
  return [...seen].sort((a, b) => (a === 'auto' ? -1 : b === 'auto' ? 1 : a.localeCompare(b)))
}

function extractCookieValue(cookieHeader: string, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    if (trimmed.slice(0, eq).trim().toLowerCase() === lower) return trimmed.slice(eq + 1).trim()
  }
  return undefined
}

async function readWebSocketData(data: unknown): Promise<string> {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data as ArrayBufferView)
  if (data && typeof (data as { text?: () => Promise<string> }).text === 'function') {
    return (data as { text: () => Promise<string> }).text()
  }
  return String(data ?? '')
}
