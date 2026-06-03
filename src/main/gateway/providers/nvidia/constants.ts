export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1'
export const NVIDIA_MODELS_PATH = '/models'
export const NVIDIA_CHAT_COMPLETIONS_PATH = '/chat/completions'
export const NVIDIA_DEFAULT_SMOKE_MODEL = 'meta/llama-3.1-8b-instruct'

export const DEFAULT_NVIDIA_SETTINGS = {
  baseUrl: NVIDIA_BASE_URL,
  firstTokenTimeoutSeconds: 120,
  streamingReadTimeoutSeconds: 300,
  maxRetries: 2,
  requestRaceEnabled: false,
  requestRaceMaxConcurrent: 3
}
