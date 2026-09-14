import type { WorkBuddyProviderSettings } from '../../types'

export const DEFAULT_WORKBUDDY_BACKEND = 'https://copilot.tencent.com'
export const DEFAULT_WORKBUDDY_BILLING_HOSTS = ['www.workbuddy.cn', 'www.codebuddy.cn']
export const DEFAULT_WORKBUDDY_DOMAIN = 'www.workbuddy.cn'
export const DEFAULT_WORKBUDDY_MODEL = 'auto'

export const WORKBUDDY_CHAT_PATH = '/v2/chat/completions'
export const WORKBUDDY_TOKEN_REFRESH_PATH = '/v2/plugin/auth/token/refresh'
export const WORKBUDDY_CHECKIN_STATUS_PATH = '/v2/billing/meter/checkin-activity-status'
export const WORKBUDDY_CHECKIN_STATUS_LEGACY_PATH = '/v2/billing/meter/checkin-status'
export const WORKBUDDY_CHECKIN_CLAIM_PATH = '/v2/billing/meter/daily-checkin'
/** Credit balance — note: no /v2 prefix on this route family. */
export const WORKBUDDY_CREDITS_SUMMARY_PATH = '/billing/meter/get-user-resource-summary'

/**
 * Chat models observed in WorkBuddy's bundled cli/product.json (48 entries,
 * filtered: no text-to-image/video tags, no vendor=tencent internals, no
 * completion/rewrite/jump/codewise utility models). Live installs are scanned
 * from product.json; this list is the offline fallback.
 */
export const WORKBUDDY_BUILT_IN_MODELS = [
  'auto',
  'default',
  'default-1.1',
  'default-1.2',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'deepseek-v3-2-volc',
  'deepseek-v3-1-volc',
  'deepseek-v3-1-lkeap',
  'deepseek-v3-1',
  'deepseek-v3-0324-lkeap',
  'deepseek-r1-0528-lkeap',
  'minimax-m2.5',
  'minimax-m3',
  'minimax-m2.7',
  'glm-5.2',
  'glm-5.1',
  'glm-5.0',
  'glm-5.0-turbo',
  'glm-5v-turbo',
  'glm-4.7',
  'glm-4.6',
  'glm-4.6v',
  'kimi-k3-1',
  'kimi-k2.7',
  'kimi-k2.6',
  'kimi-k2.5',
  'kimi-k2-thinking',
  'kimi-k2-instruct-taiji',
  'hy3',
  'hy3-preview',
  'hunyuan-chat',
  'hunyuan-2.0-thinking',
  'hunyuan-2.0-instruct',
  'kling-v3-i2v'
]

export const DEFAULT_WORKBUDDY_SETTINGS: WorkBuddyProviderSettings = {
  backend: DEFAULT_WORKBUDDY_BACKEND,
  billingHosts: [...DEFAULT_WORKBUDDY_BILLING_HOSTS],
  dataDir: '',
  productJsonPath: '',
  vpnProxyUrl: '',
  autoCheckin: true,
  firstTokenTimeoutSeconds: 60,
  streamingReadTimeoutSeconds: 120,
  maxRetries: 2
}

/** Model ids are case-insensitive on the wire; trim + passthrough. */
export function normalizeWorkBuddyModel(input: string): string {
  const trimmed = String(input || '').trim()
  return trimmed || DEFAULT_WORKBUDDY_MODEL
}

export function listWorkBuddyBuiltInModelIds(): string[] {
  return [...WORKBUDDY_BUILT_IN_MODELS]
}
