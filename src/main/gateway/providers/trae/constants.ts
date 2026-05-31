import type { TraeProviderSettings } from '../../types'

export const DEFAULT_TRAE_AUTH_BASE_URL = 'https://grow-normal.traeapi.us'
export const DEFAULT_TRAE_CORE_BASE_URL = 'https://core-normal.traeapi.us'
export const DEFAULT_TRAE_CLIENT_ID = 'ono9krqynydwx5'
export const DEFAULT_TRAE_RAW_CHAT_PATH = '/api/ide/v2/llm_raw_chat'
export const LEGACY_TRAE_MODEL_LIST_PATH = '/api/ide/v1/model_list'
export const DEFAULT_TRAE_MODEL_LIST_PATH = '/api/ide/v1/get_detail_param'
export const DEFAULT_TRAE_MODEL = 'gemini_2.5_flash'
export const DEFAULT_TRAE_LOCAL_DEBUG_PORT = 9223
export const DEFAULT_TRAE_LOCAL_APP_PATH = '/Applications/Trae.app'

export interface TraeBuiltInModel {
  id: string
  displayName: string
  capabilities: string[]
  unavailableInUS?: boolean
  note?: string
}

/**
 * Public Trae international models exposed by GatewayHub.
 *
 * The IDE's get_detail_param/model_list endpoints expose many config names, but
 * the current free international Agent chat path only completed successfully
 * through the Gemini 2.5 Flash config. Keep non-public/paid/region-gated names
 * out of /v1/models unless a later runtime smoke test proves they work.
 */
export const TRAE_BUILT_IN_MODELS: TraeBuiltInModel[] = [
  {
    id: 'gemini_2.5_flash',
    displayName: 'Gemini-2.5-Flash',
    capabilities: ['image_input']
  }
]

export const DEFAULT_TRAE_SETTINGS: TraeProviderSettings = {
  authBaseUrl: DEFAULT_TRAE_AUTH_BASE_URL,
  coreBaseUrl: DEFAULT_TRAE_CORE_BASE_URL,
  clientId: DEFAULT_TRAE_CLIENT_ID,
  rawChatPath: DEFAULT_TRAE_RAW_CHAT_PATH,
  localChatEnabled: true,
  localDebugPort: DEFAULT_TRAE_LOCAL_DEBUG_PORT,
  localAppPath: DEFAULT_TRAE_LOCAL_APP_PATH,
  modelListPath: DEFAULT_TRAE_MODEL_LIST_PATH,
  ideVersion: '3.5.60',
  productVersion: '1.107.1',
  vpnProxyUrl: '',
  firstTokenTimeoutSeconds: 60,
  streamingReadTimeoutSeconds: 120,
  maxRetries: 2,
  exposeUnavailableInUS: false
}

const ALIASES = new Map<string, string>()
for (const model of TRAE_BUILT_IN_MODELS) {
  ALIASES.set(normalizeLoose(model.id), model.id)
  ALIASES.set(normalizeLoose(model.displayName), model.id)
}
ALIASES.set('deepseekv32', 'deepseek-v3.2')
ALIASES.set('deepseekv3', 'deepseek-v3.2')
ALIASES.set('gemini25flash', 'gemini_2.5_flash')
ALIASES.set('gemini25flashpremium', 'gemini_2.5_flash')
ALIASES.set('gemini25pro', 'gemini-2.5-pro-latest')
ALIASES.set('gemini25prolatest', 'gemini-2.5-pro-latest')
ALIASES.set('gemini3flash', 'gemini-3-flash-premium')
ALIASES.set('gemini3flashpreview', 'gemini-3-flash-premium')
ALIASES.set('gemini3pro', 'gemini-3-pro')
ALIASES.set('gemini3propreview', 'gemini-3-pro')
ALIASES.set('dolaseed20code', 'dola-seed-2.0-code')
ALIASES.set('minimaxm27', 'minimax-m2.7')
ALIASES.set('kimik25', 'kimi-k2')
ALIASES.set('kimik2', 'kimi-k2')
ALIASES.set('kimik20905', 'kimi-k2')
ALIASES.set('grok4', 'grok-4')

export function normalizeTraeModel(input: string): string {
  const trimmed = String(input || '').trim()
  if (!trimmed) return DEFAULT_TRAE_MODEL
  const loose = normalizeLoose(trimmed)
  return ALIASES.get(loose) ?? trimmed.toLowerCase()
}

export function listTraeBuiltInModelIds(options?: { includeUnavailableInUS?: boolean }): string[] {
  return TRAE_BUILT_IN_MODELS.filter(
    (model) => options?.includeUnavailableInUS || !model.unavailableInUS
  ).map((model) => model.id)
}

export function describeTraeModel(id: string): TraeBuiltInModel | undefined {
  const normalized = normalizeTraeModel(id)
  return TRAE_BUILT_IN_MODELS.find((model) => model.id === normalized)
}

function normalizeLoose(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}
