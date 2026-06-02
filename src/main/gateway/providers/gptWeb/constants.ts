export const DEFAULT_GPT_WEB_BASE_URL = 'https://chatgpt.com/backend-api'

export const DEFAULT_GPT_WEB_SETTINGS = {
  baseUrl: DEFAULT_GPT_WEB_BASE_URL,
  vpnProxyUrl: '',
  firstTokenTimeoutSeconds: 30,
  streamingReadTimeoutSeconds: 120,
  maxRetries: 2
}

export const GPT_WEB_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

export const GPT_WEB_CLIENT_BUILD_NUMBER = '7034670'
export const GPT_WEB_CLIENT_VERSION = 'prod-355892676443208d0eb87aeaeb17d3ef3327f23f'

export const GPT_WEB_DEFAULT_MODEL = 'gpt-5'

export const GPT_WEB_KNOWN_MODELS = [
  // Safe, verified fallback when the live ChatGPT Web /models endpoint is
  // Cloudflare-blocked. Keep this list conservative: these are the models that
  // should be exposed as usable routes for a free ChatGPT Web account.
  'auto',
  GPT_WEB_DEFAULT_MODEL
]

export function normalizeGptWebModel(model: string): string {
  const trimmed = model.trim()
  if (!trimmed || trimmed === 'auto') return GPT_WEB_DEFAULT_MODEL
  return trimmed
}
