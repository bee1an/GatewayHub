import type { KiroProviderSettings } from '../../types'

export const DEFAULT_KIRO_SETTINGS: KiroProviderSettings = {
  region: 'us-east-1',
  vpnProxyUrl: '',
  sqliteReadonly: false,
  firstTokenTimeoutSeconds: 15,
  streamingReadTimeoutSeconds: 300,
  maxRetries: 3,
  accountRecoveryTimeoutSeconds: 60,
  accountMaxBackoffMultiplier: 1440,
  probabilisticRetryChance: 0.1
}

export const KIRO_REFRESH_URL_TEMPLATE = 'https://prod.{region}.auth.desktop.kiro.dev/refreshToken'
export const AWS_SSO_OIDC_URL_TEMPLATE = 'https://oidc.{region}.amazonaws.com/token'
export const KIRO_RUNTIME_URL_TEMPLATE = 'https://runtime.{region}.kiro.dev'
export const KIRO_API_URL_TEMPLATE = 'https://q.{region}.amazonaws.com'

export const FALLBACK_MODELS = [
  'auto-kiro',
  'claude-sonnet-4',
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'deepseek-3-2',
  'glm-5',
  'minimax-m2-1',
  'minimax-m2-5',
  'qwen3-coder-next'
]

export const SQLITE_TOKEN_KEYS = [
  'kirocli:social:token',
  'kirocli:odic:token',
  'codewhisperer:odic:token'
]

export const SQLITE_REGISTRATION_KEYS = [
  'kirocli:odic:device-registration',
  'codewhisperer:odic:device-registration'
]

export function kiroRefreshUrl(region: string): string {
  return KIRO_REFRESH_URL_TEMPLATE.replace('{region}', region)
}

export function awsSsoOidcUrl(region: string): string {
  return AWS_SSO_OIDC_URL_TEMPLATE.replace('{region}', region)
}

export function runtimeUrl(region: string): string {
  return KIRO_RUNTIME_URL_TEMPLATE.replace('{region}', region)
}

export function apiUrl(region: string): string {
  return KIRO_API_URL_TEMPLATE.replace('{region}', region)
}
