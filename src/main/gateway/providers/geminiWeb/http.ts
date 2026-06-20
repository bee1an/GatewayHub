import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { GeminiWebAccountConfig, GeminiWebProviderSettings } from '../../types'
import {
  DEFAULT_GEMINI_WEB_BASE_URL,
  GEMINI_APP_PATH,
  GEMINI_ROTATE_COOKIES_URL,
  GEMINI_STREAM_GENERATE_PATH,
  GEMINI_WEB_KNOWN_MODELS,
  GEMINI_WEB_USER_AGENT,
  geminiWebModelHeader
} from './constants'
import type {
  GeminiAccessToken,
  GeminiConversationInput,
  GeminiStreamEvent,
  GeminiWebRequestContext,
  GeminiWebSession
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

function cookieHeader(account: GeminiWebAccountConfig): string {
  return account.cookieHeader
}

function geminiHeaders(
  account: GeminiWebAccountConfig,
  modelHeader: string
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
    Host: 'gemini.google.com',
    Origin: 'https://gemini.google.com',
    Referer: 'https://gemini.google.com/',
    'User-Agent': GEMINI_WEB_USER_AGENT,
    'X-Same-Domain': '1',
    Cookie: cookieHeader(account)
  }
  if (modelHeader) headers['x-goog-ext-525001261-jspb'] = modelHeader
  return headers
}

function buildAppUrl(settings: GeminiWebProviderSettings): string {
  const base = (settings.baseUrl || DEFAULT_GEMINI_WEB_BASE_URL).replace(/\/+$/, '')
  return `${base}${GEMINI_APP_PATH}`
}

function buildStreamUrl(settings: GeminiWebProviderSettings): string {
  const base = (settings.baseUrl || DEFAULT_GEMINI_WEB_BASE_URL).replace(/\/+$/, '')
  return `${base}${GEMINI_STREAM_GENERATE_PATH}`
}

/**
 * Loads the Gemini /app page and scrapes the SNlM0e access token from the
 * embedded WIZ global. This token is the `at` form field on StreamGenerate.
 * A missing SNlM0e means the cookie is invalid / the session is signed out.
 * Also extracts the signed-in account's email from the WIZ `oPEP7c` field.
 */
export async function fetchAccessToken(ctx: GeminiWebRequestContext): Promise<GeminiWebSession> {
  const { settings, account } = ctx
  const res = await proxyFetch(
    buildAppUrl(settings),
    {
      method: 'GET',
      headers: {
        'User-Agent': GEMINI_WEB_USER_AGENT,
        Cookie: cookieHeader(account),
        Referer: 'https://gemini.google.com/'
      }
    },
    settings.vpnProxyUrl
  )
  if (!res.ok) {
    throw new Error(`Gemini Web app error ${res.status}`)
  }
  const html = await res.text()
  const m = html.match(/"SNlM0e":"(.*?)"/)
  if (!m?.[1]) {
    throw new Error('Gemini Web session tokens not found (cookie may be invalid or expired)')
  }
  // The signed-in email is embedded in the WIZ global as `oPEP7c`.
  const email = html.match(/"oPEP7c":"(.*?)"/)?.[1] || undefined
  return { token: m[1], email }
}

/** Fetches the account's available model ids; falls back to the known list. */
export async function fetchModels(ctx: GeminiWebRequestContext): Promise<string[]> {
  // Gemini's web app exposes no clean model list; return the known fallback set.
  // Real routing uses the x-goog-ext header, so this list is informational only.
  void ctx
  return [...GEMINI_WEB_KNOWN_MODELS]
}

/**
 * Rotates the __Secure-1PSIDTS cookie via accounts.google.com/RotateCookies.
 * Returns the new SIDTS value, or null if unchanged. Keeps long-lived sessions
 * alive (SIDTS expires frequently).
 */
export async function rotateSidts(ctx: GeminiWebRequestContext): Promise<string | null> {
  const { settings, account } = ctx
  try {
    const res = await proxyFetch(
      GEMINI_ROTATE_COOKIES_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader(account)
        },
        body: '[000,"-0000000000000000000"]'
      },
      settings.vpnProxyUrl
    )
    if (!res.ok) return null
    const setCookie = res.headers.get('set-cookie') ?? ''
    const m = setCookie.match(/__Secure-1PSIDTS=([^;]+)/)
    return m?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * Streams a single generation turn against the Gemini web StreamGenerate
 * endpoint. The prompt travels as plaintext inside
 *   f.req = [null, "[[[\"<prompt>\"]], null, [cid, rid, rcid]]"]
 * The response is a chunked stream of newline-delimited JSON arrays prefixed
 * by `)]}'`; each array's element [2] is a JSON string whose [4] holds the
 * candidate list. We parse incrementally and yield text deltas.
 */
export async function* streamGeminiConversation(
  ctx: GeminiWebRequestContext,
  input: GeminiConversationInput
): AsyncGenerator<GeminiStreamEvent> {
  const { settings, account } = ctx
  // The __Secure-1PSIDTS cookie expires every few minutes. If the access-token
  // fetch fails because the session looks signed-out, rotate SIDTS once and
  // retry before giving up. rotateSidts mutates account.cookieHeader in place.
  const session = await fetchAccessToken(ctx).catch(async (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes('session tokens not found')) throw err
    const newSidts = await rotateSidts(ctx)
    if (!newSidts) throw err
    account.cookieHeader = patchSidts(account.cookieHeader, newSidts)
    return fetchAccessToken(ctx)
  })
  const accessToken: GeminiAccessToken = session.token
  const modelHeader = geminiWebModelHeader(input.model)

  const metadata = input.metadata ?? [null, null, null]
  // inner = [[prompt], null, [cid, rid, rcid]]
  const inner = JSON.stringify([[input.prompt], null, metadata])
  // f.req = [null, "<inner json string>"]
  const fReq = JSON.stringify([null, inner])
  const body = new URLSearchParams({ at: accessToken, 'f.req': fReq }).toString()

  const res = await proxyFetch(
    buildStreamUrl(settings),
    {
      method: 'POST',
      headers: geminiHeaders(account, modelHeader),
      body
    },
    settings.vpnProxyUrl
  )

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Gemini Web stream error ${res.status}: ${text.slice(0, 200)}`)
  }
  if (!res.body) throw new Error('Gemini Web stream returned no body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let sawFirstContent = false
  const firstTokenDeadline = Date.now() + settings.firstTokenTimeoutSeconds * 1000
  let readDeadline = firstTokenDeadline
  const streamTimeout = settings.streamingReadTimeoutSeconds * 1000
  let finished = false

  try {
    while (true) {
      const remaining = readDeadline - Date.now()
      if (remaining <= 0) {
        throw new Error(
          sawFirstContent ? 'Gemini Web stream read timed out' : 'Gemini Web first token timed out'
        )
      }
      const read = await reader.read()
      if (read.done) break
      buffer += decoder.decode(read.value, { stream: true })

      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        const events = parseStreamLine(line)
        for (const event of events) {
          if (event.type === 'text' && event.delta) {
            sawFirstContent = true
            readDeadline = Date.now() + streamTimeout
          }
          yield event
          if (event.type === 'done') {
            finished = true
            return
          }
          if (event.type === 'error') return
        }
      }
    }
    // The StreamGenerate response may not end with a trailing newline, so the
    // final candidate payload can remain unparsed in the buffer. Flush it.
    if (buffer.trim()) {
      const events = parseStreamLine(buffer)
      for (const event of events) {
        if (event.type === 'text' && event.delta) sawFirstContent = true
        yield event
        if (event.type === 'done') {
          finished = true
          break
        }
      }
    }
    // Stream ended without an explicit done; emit a terminal done so the
    // provider's failover loop closes cleanly.
    if (!finished) yield { type: 'done' }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

/**
 * Parses one newline-delimited line of the StreamGenerate response. A line is
 * either the `)]}'` prefix, a length marker (decimal), or a JSON array whose
 * element [2] is a JSON string holding the candidate payload. We extract the
 * candidate text from [4][i][1][0] of that payload.
 */
function parseStreamLine(line: string): GeminiStreamEvent[] {
  const trimmed = line.trim()
  if (!trimmed || trimmed === ")]}'") return []
  if (/^\d+$/.test(trimmed)) return [] // length marker
  let arr: unknown
  try {
    arr = JSON.parse(trimmed)
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []

  const events: GeminiStreamEvent[] = []
  for (const entry of arr) {
    if (!Array.isArray(entry)) continue
    // StreamGenerate frames: ["wrb.fr", rpcid, innerJsonString, ...] OR a raw
    // data array. Find the JSON-string slot holding the candidate payload.
    let innerStr: string | null = null
    for (let i = 0; i < entry.length; i++) {
      if (typeof entry[i] === 'string' && (entry[i] as string).startsWith('[')) {
        innerStr = entry[i] as string
        break
      }
    }
    if (!innerStr) continue

    let payload: unknown
    try {
      payload = JSON.parse(innerStr)
    } catch {
      continue
    }
    if (!Array.isArray(payload)) continue

    // Error frame: payload[0] === "er"
    if (payload[0] === 'er') {
      const code = payload[2] ?? payload[1]
      events.push({
        type: 'error',
        message: `Gemini Web generation error (code ${code ?? 'unknown'})`
      })
      continue
    }

    // Candidate list at payload[4]; each candidate's text at [1][0].
    const candidates = payload[4]
    if (Array.isArray(candidates)) {
      let emittedText = false
      for (const candidate of candidates) {
        if (!Array.isArray(candidate)) continue
        const textNode = candidate[1]
        let text = ''
        if (Array.isArray(textNode) && typeof textNode[0] === 'string') {
          text = textNode[0]
        }
        if (text) {
          events.push({ type: 'text', delta: text })
          emittedText = true
        }
      }
      // StreamGenerate delivers the full text in one shot (not token-by-token),
      // so a payload carrying a non-empty candidate is the terminal frame.
      // Thinking models (e.g. 3.1 Pro) emit an empty-candidate placeholder frame
      // first; only treat the frame as terminal once real text arrives.
      if (emittedText) {
        events.push({ type: 'done' })
      }
    }
  }
  return events
}

/** Replaces the __Secure-1PSIDTS (and -3PSIDTS) value in a cookie header. */
function patchSidts(cookieHeader: string, newSidts: string): string {
  let updated = cookieHeader
    .replace(/__Secure-1PSIDTS=[^;]+/g, `__Secure-1PSIDTS=${newSidts}`)
    .replace(/__Secure-3PSIDTS=[^;]+/g, `__Secure-3PSIDTS=${newSidts}`)
  if (!updated.includes(`__Secure-1PSIDTS=${newSidts}`)) {
    updated += `; __Secure-1PSIDTS=${newSidts}`
  }
  return updated
}
