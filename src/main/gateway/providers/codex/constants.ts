import type { CodexProviderSettings } from '../../types'

export const DEFAULT_CODEX_SETTINGS: CodexProviderSettings = {
  baseUrl: 'https://chatgpt.com/backend-api',
  vpnProxyUrl: '',
  firstTokenTimeoutSeconds: 30,
  streamingReadTimeoutSeconds: 600,
  maxRetries: 2,
  callbackPort: 1455,
  refreshSkewSeconds: 60,
  refreshIntervalSeconds: 28 * 24 * 3600
}

// OpenAI OAuth endpoints (与 Codex CLI / Codex Desktop 保持一致)
export const OPENAI_AUTH_ISSUER = 'https://auth.openai.com'
export const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEZ73f0CkXaXp7hrann'
export const OPENAI_OAUTH_SCOPE =
  'openid profile email offline_access api.connectors.read api.connectors.invoke'
export const OPENAI_AUTHORIZE_URL = `${OPENAI_AUTH_ISSUER}/oauth/authorize`
export const OPENAI_TOKEN_URL = `${OPENAI_AUTH_ISSUER}/oauth/token`
export const OPENAI_DEVICE_CODE_URL = `${OPENAI_AUTH_ISSUER}/api/accounts/deviceauth/usercode`
export const OPENAI_DEVICE_TOKEN_URL = `${OPENAI_AUTH_ISSUER}/api/accounts/deviceauth/token`
export const OPENAI_DEVICE_VERIFICATION_URL = `${OPENAI_AUTH_ISSUER}/codex/device`
export const OPENAI_DEVICE_REDIRECT_URI = `${OPENAI_AUTH_ISSUER}/deviceauth/callback`

/** ChatGPT 后端必带的 originator 头 */
export const CODEX_ORIGINATOR = 'codex_cli_rs'
/** 用 GatewayHub 自己的 UA 标识 */
export const CODEX_USER_AGENT = 'gatewayhub-codex'

export const DEFAULT_CODEX_MODEL = 'gpt-5'

/** 支持的 Codex 模型（用于 listModels 默认值）。Code 路径会用 normalizeCodexModel 兜底匹配 */
export const FALLBACK_CODEX_MODELS = [
  'gpt-5',
  'gpt-5-codex',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-5-pro',
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini'
]

/** 把 model 归一化到价格表 key（剥离 openai/ 前缀和 -YYYY-MM-DD 日期后缀） */
export function normalizeCodexModel(model: string): string {
  const trimmed = model.trim().toLowerCase()
  const slash = trimmed.indexOf('/')
  const noPrefix = slash >= 0 ? trimmed.slice(slash + 1) : trimmed
  // 剥离日期后缀：gpt-5-2025-08-01 → gpt-5
  return noPrefix.replace(/-\d{4}-\d{2}-\d{2}$/, '')
}

export function codexResponsesUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  if (base.endsWith('/backend-api')) return `${base}/codex/responses`
  return `${base}/api/codex/responses`
}

export function codexUsageUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  if (base.endsWith('/backend-api')) return `${base}/wham/usage`
  return `${base}/api/wham/usage`
}
