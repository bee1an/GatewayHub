import type { QoderProviderSettings } from '../../types'

export type QoderKnownModel = {
  id: string
  label: string
  tier: 'free' | 'low' | 'standard' | 'high' | 'highest' | 'frontier'
  description: string
}

export const QODER_PROVIDER_NAME = 'qoder'
export const QODER_CLI_COMPAT_VERSION = '1.0.19'
export const QODER_CLI_USER_AGENT = `qoder/${QODER_CLI_COMPAT_VERSION}`
export const QODER_CLI_SESSION_TYPE = 'qodercli'
export const QODER_CLI_BUSINESS_STAGE = 'init'
export const QODER_CLI_RUNTIME_CONFIG = {
  client_type: '5',
  business_product: 'cli',
  business_type: 'agent',
  scene: 'assistant'
} as const

export const QODER_KNOWN_MODELS: QoderKnownModel[] = [
  {
    id: 'lite',
    label: 'Lite',
    tier: 'free',
    description: 'Qoder Lite tier — free lightweight tasks and quick Q&A.'
  },
  {
    id: 'efficient',
    label: 'Efficient',
    tier: 'low',
    description: 'Qoder Efficient tier — low-credit everyday coding and completion.'
  },
  {
    id: 'auto',
    label: 'Auto',
    tier: 'standard',
    description: 'Qoder Auto tier — smart routing for most multi-step coding tasks.'
  },
  {
    id: 'performance',
    label: 'Performance',
    tier: 'high',
    description: 'Qoder Performance tier — challenging engineering work and large codebases.'
  },
  {
    id: 'ultimate',
    label: 'Ultimate',
    tier: 'highest',
    description: 'Qoder Ultimate tier — maximum reasoning and output quality.'
  },
  {
    id: 'qmodel_latest',
    label: 'Qwen3.7 Max',
    tier: 'frontier',
    description: 'Qoder legacy model key for Qwen3.7-Max.'
  },
  {
    id: 'qmodel',
    label: 'Qwen3.7 Plus',
    tier: 'high',
    description: 'Qoder legacy model key for Qwen3.7-Plus.'
  },
  {
    id: 'qwen3.7-max',
    label: 'Qwen3.7 Max',
    tier: 'frontier',
    description: 'Compatibility alias routed to qmodel_latest through Qoder legacy direct API.'
  },
  {
    id: 'qwen3.7-plus',
    label: 'Qwen3.7 Plus',
    tier: 'high',
    description: 'Compatibility alias routed to qmodel through Qoder legacy direct API.'
  },
  {
    id: 'dmodel',
    label: 'DeepSeek-V4-Pro',
    tier: 'frontier',
    description: 'Qoder legacy model key for DeepSeek-V4-Pro.'
  },
  {
    id: 'dfmodel',
    label: 'DeepSeek-V4-Flash',
    tier: 'high',
    description: 'Qoder legacy model key for DeepSeek-V4-Flash.'
  },
  {
    id: 'gm51model',
    label: 'GLM-5.1',
    tier: 'frontier',
    description: 'Qoder legacy model key for GLM-5.1.'
  },
  {
    id: 'kmodel',
    label: 'Kimi-K2.6',
    tier: 'high',
    description: 'Qoder legacy model key for Kimi-K2.6.'
  },
  {
    id: 'mmodel',
    label: 'MiniMax-M3',
    tier: 'high',
    description: 'Qoder legacy model key for MiniMax-M3.'
  }
]

export const QODER_KNOWN_MODEL_IDS = QODER_KNOWN_MODELS.map((model) => model.id)
export const QODER_DIRECT_MODEL_IDS = [
  'lite',
  'efficient',
  'auto',
  'performance',
  'ultimate'
] as const
export const QODER_LEGACY_MODEL_IDS = [
  'qmodel_latest',
  'qmodel',
  'dmodel',
  'dfmodel',
  'gm51model',
  'kmodel',
  'mmodel'
] as const
export type QoderLegacyModelId = (typeof QODER_LEGACY_MODEL_IDS)[number]
export interface QoderLegacyModelConfig {
  key: QoderLegacyModelId
  display_name: string
  is_vl: boolean
  is_reasoning: boolean
  max_input_tokens: number
}

export const QODER_LEGACY_MODEL_CONFIGS: Record<QoderLegacyModelId, QoderLegacyModelConfig> = {
  qmodel_latest: {
    key: 'qmodel_latest',
    display_name: 'Qwen3.7-Max',
    is_vl: true,
    is_reasoning: false,
    max_input_tokens: 180_000
  },
  qmodel: {
    key: 'qmodel',
    display_name: 'Qwen3.7-Plus',
    is_vl: true,
    is_reasoning: false,
    max_input_tokens: 180_000
  },
  dmodel: {
    key: 'dmodel',
    display_name: 'DeepSeek-V4-Pro',
    is_vl: true,
    is_reasoning: true,
    max_input_tokens: 180_000
  },
  dfmodel: {
    key: 'dfmodel',
    display_name: 'DeepSeek-V4-Flash',
    is_vl: true,
    is_reasoning: true,
    max_input_tokens: 180_000
  },
  gm51model: {
    key: 'gm51model',
    display_name: 'GLM-5.1',
    is_vl: true,
    is_reasoning: true,
    max_input_tokens: 180_000
  },
  kmodel: {
    key: 'kmodel',
    display_name: 'Kimi-K2.6',
    is_vl: true,
    is_reasoning: false,
    max_input_tokens: 256_000
  },
  mmodel: {
    key: 'mmodel',
    display_name: 'MiniMax-M3',
    is_vl: true,
    is_reasoning: false,
    max_input_tokens: 180_000
  }
}
export const QODER_DEFAULT_MODEL = 'auto'

export const DEFAULT_QODER_SETTINGS: QoderProviderSettings = {
  apiBaseUrl: 'https://api2-v2.qoder.sh',
  qoderCliPath: '',
  vpnProxyUrl: '',
  firstTokenTimeoutSeconds: 120,
  streamingReadTimeoutSeconds: 300,
  maxRetries: 2,
  maxOutputTokens: '16k'
}

const ALIAS_MAP: Record<string, string> = {
  'gpt-4': 'auto',
  'gpt-4-turbo': 'auto',
  'gpt-4o': 'auto',
  'gpt-4.1': 'auto',
  'gpt-4.1-mini': 'efficient',
  'gpt-4o-mini': 'efficient',
  'gpt-3.5-turbo': 'lite',
  o1: 'ultimate',
  'o1-mini': 'performance',
  'o3-mini': 'performance',
  'o4-mini': 'performance',
  'claude-3-opus': 'ultimate',
  'claude-3-sonnet': 'performance',
  'claude-3-haiku': 'efficient',
  'claude-3.5-sonnet': 'auto',
  'claude-3.5-haiku': 'efficient',
  'claude-3.7-sonnet': 'auto',
  'claude-sonnet-4': 'auto',
  'claude-sonnet-4.5': 'auto',
  'claude-opus-4': 'ultimate',
  'claude-opus-4.1': 'ultimate',
  'gemini-pro': 'performance',
  'gemini-flash': 'efficient',
  qwen: 'qmodel',
  qmodel_latest: 'qmodel_latest',
  qmodel: 'qmodel',
  qwen37max: 'qmodel_latest',
  'qwen3.7-max': 'qmodel_latest',
  'qwen-3.7-max': 'qmodel_latest',
  'qwen3.7max': 'qmodel_latest',
  'qoder/qwen3.7-max': 'qmodel_latest',
  qwen37plus: 'qmodel',
  'qwen3.7-plus': 'qmodel',
  'qwen-3.7-plus': 'qmodel',
  'qwen3.7plus': 'qmodel',
  'qoder/qwen3.7-plus': 'qmodel',
  qwen36plus: 'qmodel',
  'qwen-3.6-plus': 'qmodel',
  deepseek: 'dmodel',
  dmodel: 'dmodel',
  'deepseek-v4': 'dmodel',
  'deepseek-v4-pro': 'dmodel',
  'qoder/deepseek-v4-pro': 'dmodel',
  dfmodel: 'dfmodel',
  'deepseek-flash': 'dfmodel',
  'deepseek-v4-flash': 'dfmodel',
  'qoder/deepseek-v4-flash': 'dfmodel',
  kimi: 'kmodel',
  kmodel: 'kmodel',
  'kimi-k2.6': 'kmodel',
  minimax: 'mmodel',
  mmodel: 'mmodel',
  'minimax-m3': 'mmodel',
  glm: 'gm51model',
  glm51: 'gm51model',
  gm51model: 'gm51model',
  'glm-5.1': 'gm51model'
}

export function normalizeQoderModel(requestedModel?: string): string {
  const raw = String(requestedModel || '').trim()
  if (!raw) return QODER_DEFAULT_MODEL
  if ((QODER_DIRECT_MODEL_IDS as readonly string[]).includes(raw)) return raw

  const lower = raw.toLowerCase()
  if ((QODER_DIRECT_MODEL_IDS as readonly string[]).includes(lower)) return lower
  if (ALIAS_MAP[lower]) return ALIAS_MAP[lower]

  if (lower.includes('claude')) {
    if (lower.includes('opus')) return 'ultimate'
    if (lower.includes('haiku')) return 'efficient'
    return 'auto'
  }
  if (lower.includes('gpt-4') || lower.includes('gpt4')) {
    if (lower.includes('mini')) return 'efficient'
    return 'auto'
  }
  if (lower.includes('gpt-3') || lower.includes('gpt3')) return 'lite'
  if (/^o\d/.test(lower)) return lower.includes('mini') ? 'performance' : 'ultimate'
  if (lower.includes('gemini')) return lower.includes('flash') ? 'efficient' : 'performance'
  if (lower.includes('qwen')) return lower.includes('max') ? 'qmodel_latest' : 'qmodel'
  if (lower.includes('deepseek')) return lower.includes('flash') ? 'dfmodel' : 'dmodel'
  if (lower.includes('kimi') || lower.includes('moonshot')) return 'kmodel'
  if (lower.includes('glm')) return 'gm51model'
  if (lower.includes('minimax')) return 'mmodel'

  // Qoder supports custom models configured inside qodercli; let unknown model IDs pass through.
  return raw
}

export function normalizeQoderMaxOutputTokens(value: unknown): '16k' | '32k' {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  return normalized === '32k' ? '32k' : '16k'
}

export function isQoderLegacyModel(model: string): model is QoderLegacyModelId {
  return QODER_LEGACY_MODEL_IDS.includes(model as QoderLegacyModelId)
}
