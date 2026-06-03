export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
export const OPENROUTER_KEY_PATH = '/key'
export const OPENROUTER_MODELS_PATH = '/models'
export const OPENROUTER_CHAT_COMPLETIONS_PATH = '/chat/completions'
export const OPENROUTER_FREE_ROUTER_MODEL = 'openrouter/free'

export const DEFAULT_OPENROUTER_SETTINGS = {
  baseUrl: OPENROUTER_BASE_URL,
  firstTokenTimeoutSeconds: 120,
  streamingReadTimeoutSeconds: 300,
  maxRetries: 2,
  requestRaceEnabled: false,
  requestRaceMaxConcurrent: 3
}
