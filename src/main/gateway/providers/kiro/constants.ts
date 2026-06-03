import type { KiroProviderSettings } from '../../types'

export const DEFAULT_KIRO_SETTINGS: KiroProviderSettings = {
  region: 'us-east-1',
  vpnProxyUrl: '',
  sqliteReadonly: false,
  firstTokenTimeoutSeconds: 60,
  streamingReadTimeoutSeconds: 300,
  maxRetries: 3,
  maxConcurrentRequests: 4,
  maxConcurrentLargePromptRequests: 1,
  largePromptBytes: 300_000,
  accountRecoveryTimeoutSeconds: 60,
  accountMaxBackoffMultiplier: 1440,
  probabilisticRetryChance: 0.1
}

export function normalizeKiroSettings(
  settings: Partial<KiroProviderSettings>
): KiroProviderSettings {
  const merged = { ...DEFAULT_KIRO_SETTINGS, ...settings }
  return {
    ...merged,
    firstTokenTimeoutSeconds: clampPositiveInt(merged.firstTokenTimeoutSeconds, 60, 1, 600),
    streamingReadTimeoutSeconds: clampPositiveInt(merged.streamingReadTimeoutSeconds, 300, 1, 1800),
    maxRetries: clampPositiveInt(merged.maxRetries, 3, 1, 10),
    maxConcurrentRequests: clampPositiveInt(merged.maxConcurrentRequests, 4, 1, 32),
    maxConcurrentLargePromptRequests: clampPositiveInt(
      merged.maxConcurrentLargePromptRequests,
      1,
      1,
      Math.max(1, clampPositiveInt(merged.maxConcurrentRequests, 4, 1, 32))
    ),
    largePromptBytes: clampPositiveInt(merged.largePromptBytes, 300_000, 32_000, 20_000_000),
    accountRecoveryTimeoutSeconds: clampPositiveInt(
      merged.accountRecoveryTimeoutSeconds,
      60,
      1,
      3600
    ),
    accountMaxBackoffMultiplier: clampPositiveInt(
      merged.accountMaxBackoffMultiplier,
      1440,
      1,
      100_000
    ),
    probabilisticRetryChance: clampNumber(merged.probabilisticRetryChance, 0.1, 0, 1)
  }
}

function clampPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export const KIRO_REFRESH_URL_TEMPLATE = 'https://prod.{region}.auth.desktop.kiro.dev/refreshToken'
export const AWS_SSO_OIDC_URL_TEMPLATE = 'https://oidc.{region}.amazonaws.com/token'
export const KIRO_RUNTIME_URL_TEMPLATE = 'https://runtime.{region}.kiro.dev'
export const KIRO_API_URL_TEMPLATE = 'https://q.{region}.amazonaws.com'

export const DEFAULT_KIRO_MODEL = 'auto'

export const FALLBACK_MODELS = [
  DEFAULT_KIRO_MODEL,
  'claude-opus-4.7',
  'claude-opus-4.6',
  'claude-sonnet-4.6',
  'claude-opus-4.5',
  'claude-sonnet-4.5',
  'claude-sonnet-4',
  'claude-haiku-4.5',
  'deepseek-3.2',
  'minimax-m2.5',
  'minimax-m2.1',
  'glm-5',
  'qwen3-coder-next'
]

export function normalizeKiroModelId(model: string): string {
  const value = model.trim()
  if (!value || value === 'auto-kiro') return DEFAULT_KIRO_MODEL
  return value.replace(/(\d+)-(\d+)$/g, '$1.$2')
}

export function toKiroModelId(model: string): string {
  return normalizeKiroModelId(model)
}

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
