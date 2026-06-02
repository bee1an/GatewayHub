export interface GrokWebUser {
  userId?: string
  email?: string
  givenName?: string
  familyName?: string
  xUserId?: string
  xUsername?: string
  xSubscriptionType?: string
  sessionTierId?: string
  [key: string]: unknown
}

export interface GrokWebModelConfig {
  modelId?: string
  name?: string
  description?: string
  modeName?: string
  modelMode?: string
  promptingBackend?: string
  [key: string]: unknown
}

export interface GrokWebModeConfig {
  id?: string
  title?: string
  description?: string
  availability?: {
    available?: boolean
    unavailable?: { message?: string }
    requiresUpgrade?: { message?: string; minimumSubscriptionTier?: string }
    comingSoon?: { message?: string; eta?: string }
  }
  [key: string]: unknown
}

export interface GrokWebModelsResponse {
  models?: GrokWebModelConfig[]
  unavailableModels?: GrokWebModelConfig[]
  defaultFreeModel?: string
  defaultProModel?: string
  defaultAnonModel?: string
  defaultHeavyModel?: string
  defaultFreeMode?: string
  defaultProMode?: string
  defaultAnonMode?: string
  defaultHeavyMode?: string
}

export interface GrokWebModesResponse {
  modes?: GrokWebModeConfig[]
  defaultModeId?: string
}

export interface GrokGatewayEvent {
  type?: string
  event_id?: string
  response_id?: string
  delta?: string
  response?: { id?: string; status?: string; [key: string]: unknown }
  item?: { id?: string; [key: string]: unknown }
  error?: { message?: string; code?: string; type?: string; [key: string]: unknown }
  x_grok?: {
    is_thinking?: boolean
    message_tag?: string
    side_by_side_index?: number
    [key: string]: unknown
  }
  [key: string]: unknown
}
