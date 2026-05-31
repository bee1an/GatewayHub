export interface GptWebAuthJson {
  user: { id: string; name: string; email: string; idp?: string; iat?: number; mfa?: boolean }
  expires: string
  account: { id: string; planType: string; structure?: string }
  accessToken: string
  sessionToken: string
  authProvider?: string
}

export interface GptWebRequestBody {
  action: 'next' | 'continue' | 'variant'
  messages: GptWebMessage[]
  model: string
  conversation_id?: string
  parent_message_id?: string
  timezone_offset_min: number
  timezone: string
  conversation_mode: { kind: string }
  enable_message_followups: boolean
  system_hints: string[]
  supports_buffering: boolean
  supported_encodings: string[]
  client_contextual_info: {
    is_dark_mode: boolean
    time_since_loaded: number
    page_height: number
    page_width: number
    pixel_ratio: number
    screen_height: number
    screen_width: number
    app_name: string
  }
}

export interface GptWebMessage {
  id: string
  author: { role: string }
  content: { content_type: string; parts: string[] }
  metadata?: Record<string, unknown>
}

export interface SentinelPrepareResponse {
  persona: string
  prepare_token: string
  turnstile?: { required: boolean; dx?: string }
  proofofwork?: { required: boolean; seed: string; difficulty: string }
  so?: { required: boolean; collector_dx?: string; snapshot_dx?: string }
}

export interface SentinelFinalizeResponse {
  persona: string
  token: string
  expire_after: number
  expire_at: number
}

export interface ConversationPrepareResponse {
  status: string
  conduit_token: string
}

export interface GptWebDeltaEvent {
  p?: string
  o?: string
  v: unknown
  c?: number
}
