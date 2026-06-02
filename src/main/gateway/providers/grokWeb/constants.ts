export const DEFAULT_GROK_WEB_BASE_URL = 'https://grok.com'
export const DEFAULT_GROK_WEB_WS_URL = 'wss://grok.com/ws/gw/'

export const DEFAULT_GROK_WEB_SETTINGS = {
  baseUrl: DEFAULT_GROK_WEB_BASE_URL,
  wsUrl: DEFAULT_GROK_WEB_WS_URL,
  vpnProxyUrl: '',
  firstTokenTimeoutSeconds: 30,
  streamingReadTimeoutSeconds: 180,
  maxRetries: 1
}

export const GROK_WEB_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

// Grok Web 的 WS v2 入口本身支持 auto mode；模型/模式发现失败时只暴露这个保守兜底，避免 UI 展示一堆未必可用的付费模式。
export const GROK_WEB_DEFAULT_MODEL = 'auto'
export const GROK_WEB_KNOWN_MODELS = [GROK_WEB_DEFAULT_MODEL]

export function normalizeGrokWebModel(model: string): string {
  const trimmed = String(model || '').trim()
  return trimmed || GROK_WEB_DEFAULT_MODEL
}
