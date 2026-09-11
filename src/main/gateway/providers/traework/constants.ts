import type { TraeWorkProviderSettings } from '../../types'

export const DEFAULT_TRAEWORK_CORE_BASE_URL = 'https://api5-normal.mchost.guru'
export const DEFAULT_TRAEWORK_AUTH_BASE_URL = 'https://api.trae.cn'
export const DEFAULT_TRAEWORK_CLIENT_ID = 'ono9krqynydwx5'
export const DEFAULT_TRAEWORK_RAW_CHAT_PATH = '/api/agent/v3/llm_utils_chat'
export const DEFAULT_TRAEWORK_DETAIL_PARAM_PATH = '/api/ide/v1/batch_get_detail_param'
export const DEFAULT_TRAEWORK_APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8'
export const DEFAULT_TRAEWORK_VERSION_CODE = '20260901'
export const DEFAULT_TRAEWORK_IDE_VERSION = '0.1.64'
export const DEFAULT_TRAEWORK_PACKAGE_TYPE = 'stable_cn'
export const DEFAULT_TRAEWORK_FUNCTION = 'chat_v3'
export const DEFAULT_TRAEWORK_MODEL = 'glm-5.3'

/**
 * Agent/function names TraeWork registers in batch_get_detail_param. Chat-capable
 * configs are filtered by usage=chat_completion + config_switch + !invisible.
 */
export const TRAEWORK_DETAIL_FUNCTIONS = [
  'assistant',
  'solo_agent_lite',
  'solo_coder',
  'solo_agent_remote',
  'solo_work_lite',
  'solo_work_remote',
  'solo_design_lite',
  'solo_design_remote',
  'builder',
  'chat_v3',
  'chat',
  'inline_chat',
  'multimodal'
]

export interface TraeWorkBuiltInModel {
  id: string
  displayName: string
  capabilities?: string[]
  note?: string
}

/**
 * Display metadata for TraeWork config_names observed in the CN catalog. The
 * published /v1/models list comes from each account's batch_get_detail_param
 * response; this table is only a fallback/description source. TraeWork model
 * ids are the user-facing config_name values (e.g. "glm-5.3"), NOT the internal
 * `__dev` variants the agent pipeline resolves to.
 */
export const TRAEWORK_BUILT_IN_MODELS: TraeWorkBuiltInModel[] = [
  { id: 'glm-5.3', displayName: 'GLM-5.3' },
  { id: 'glm-5.2', displayName: 'GLM-5.2' },
  { id: 'kimi-k3', displayName: 'Kimi K3' },
  { id: 'kimi-k2.7-code', displayName: 'Kimi K2.7 Code' },
  { id: 'kimi-k2.6', displayName: 'Kimi K2.6' },
  { id: 'minimax-m3', displayName: 'MiniMax M3' },
  { id: 'qwen3.8-max', displayName: 'Qwen 3.8 Max' },
  { id: 'qwen-3.7-plus', displayName: 'Qwen 3.7 Plus' },
  { id: 'Doubao-Seed-2.1-Pro', displayName: 'Doubao Seed 2.1 Pro' },
  { id: 'Doubao-Seed-2.1-Turbo', displayName: 'Doubao Seed 2.1 Turbo' },
  { id: 'Doubao-Seed-Evolving', displayName: 'Doubao Seed Evolving' },
  { id: 'Doubao-Seed-Code', displayName: 'Doubao Seed Code' },
  { id: 'DeepSeek-V4-Flash-Official', displayName: 'DeepSeek V4 Flash' },
  { id: 'DeepSeek-V4-Pro-Official', displayName: 'DeepSeek V4 Pro' }
]

export const DEFAULT_TRAEWORK_SETTINGS: TraeWorkProviderSettings = {
  coreBaseUrl: DEFAULT_TRAEWORK_CORE_BASE_URL,
  authBaseUrl: DEFAULT_TRAEWORK_AUTH_BASE_URL,
  clientId: DEFAULT_TRAEWORK_CLIENT_ID,
  rawChatPath: DEFAULT_TRAEWORK_RAW_CHAT_PATH,
  detailParamPath: DEFAULT_TRAEWORK_DETAIL_PARAM_PATH,
  appId: DEFAULT_TRAEWORK_APP_ID,
  ideVersion: DEFAULT_TRAEWORK_IDE_VERSION,
  versionCode: DEFAULT_TRAEWORK_VERSION_CODE,
  packageType: DEFAULT_TRAEWORK_PACKAGE_TYPE,
  function: DEFAULT_TRAEWORK_FUNCTION,
  dataDir: '',
  vpnProxyUrl: '',
  firstTokenTimeoutSeconds: 60,
  streamingReadTimeoutSeconds: 120,
  maxRetries: 2
}

const ALIASES = new Map<string, string>()
for (const model of TRAEWORK_BUILT_IN_MODELS) {
  ALIASES.set(normalizeLoose(model.id), model.id)
  ALIASES.set(normalizeLoose(model.displayName), model.id)
}
ALIASES.set('glm53', 'glm-5.3')
ALIASES.set('glm52', 'glm-5.2')
ALIASES.set('doubaoseed21pro', 'Doubao-Seed-2.1-Pro')
ALIASES.set('deepseekv4flash', 'DeepSeek-V4-Flash-Official')
ALIASES.set('deepseekv4pro', 'DeepSeek-V4-Pro-Official')

/**
 * TraeWork config_names are case-sensitive (e.g. "Doubao-Seed-2.1-Pro"), so
 * normalization is trim + alias lookup only — never lowercase the result.
 */
export function normalizeTraeWorkModel(input: string): string {
  const trimmed = String(input || '').trim()
  if (!trimmed) return DEFAULT_TRAEWORK_MODEL
  return ALIASES.get(normalizeLoose(trimmed)) ?? trimmed
}

export function listTraeWorkBuiltInModelIds(): string[] {
  return TRAEWORK_BUILT_IN_MODELS.map((model) => model.id)
}

export function describeTraeWorkModel(id: string): TraeWorkBuiltInModel | undefined {
  const normalized = normalizeTraeWorkModel(id)
  return TRAEWORK_BUILT_IN_MODELS.find((model) => model.id === normalized)
}

function normalizeLoose(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}
