export const DEFAULT_GEMINI_WEB_BASE_URL = 'https://gemini.google.com'

// StreamGenerate is the real generation endpoint (NOT batchexecute). Discovered
// from the reference implementation of gemini_webapi: the prompt travels as
// plaintext inside f.req=[null,"[[[\"<prompt>\"]],null,metadata]"].
export const GEMINI_STREAM_GENERATE_PATH =
  '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate'
export const GEMINI_APP_PATH = '/app'
export const GEMINI_ROTATE_COOKIES_URL = 'https://accounts.google.com/RotateCookies'

export const DEFAULT_GEMINI_WEB_SETTINGS = {
  baseUrl: DEFAULT_GEMINI_WEB_BASE_URL,
  vpnProxyUrl: '',
  firstTokenTimeoutSeconds: 30,
  streamingReadTimeoutSeconds: 120,
  maxRetries: 1
}

export const GEMINI_WEB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// Gemini Web exposes no model list endpoint; models are selected via an
// x-goog-ext-525001261-jspb header carrying a per-model token. UNSPECIFIED
// (empty header) routes to the account's default. We expose the known set so
// the gateway can route and the UI can list options.
//
// Model ids and header tokens were captured live from the Gemini web app's
// model selector (bard-mode-option-<id>). The header payload is
//   [1,null,null,null,"<mode-id>",null,null,0,[4],null,null,1]
// only the mode-id at index 4 varies per model; the rest is a fixed
// capability mask. The browser appends a per-session device UUID at the tail,
// but the trimmed form routes correctly (verified against the reference impl).
export const GEMINI_WEB_DEFAULT_MODEL = 'gemini-3.5-flash'

interface GeminiWebModelHeader {
  name: string
  /** x-goog-ext-525001261-jspb header value; empty means "use account default". */
  header: string
}

function modelHeader(modeId: string): string {
  return JSON.stringify([1, null, null, null, modeId, null, null, 0, [4], null, null, 1])
}

export const GEMINI_WEB_MODELS: Record<string, GeminiWebModelHeader> = {
  'gemini-3.1-pro': { name: 'gemini-3.1-pro', header: modelHeader('e6fa609c3fa255c0') },
  'gemini-3.5-flash': { name: 'gemini-3.5-flash', header: modelHeader('56fdd199312815e2') },
  'gemini-3.1-flash-lite': {
    name: 'gemini-3.1-flash-lite',
    header: modelHeader('8c46e95b1a07cecc')
  },
  unspecified: { name: 'unspecified', header: '' }
}

export const GEMINI_WEB_KNOWN_MODELS = [
  'gemini-3.1-pro',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite'
]

export function normalizeGeminiWebModel(model: string): string {
  const trimmed = String(model || '').trim()
  return trimmed || GEMINI_WEB_DEFAULT_MODEL
}

/** Resolves a model id to its x-goog-ext-525001261-jspb header value (empty = default). */
export function geminiWebModelHeader(model: string): string {
  return GEMINI_WEB_MODELS[normalizeGeminiWebModel(model)]?.header ?? ''
}
