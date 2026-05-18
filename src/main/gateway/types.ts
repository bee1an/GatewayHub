export type ProviderName = 'kiro' | 'codex' | 'gemini' | string

export interface GatewayHubConfig {
  version: number
  server: GatewayServerConfig
  defaultProvider: ProviderName
  providers: {
    kiro: KiroProviderConfig
    codex: PlaceholderProviderConfig
    gemini: PlaceholderProviderConfig
    [name: string]: unknown
  }
}

export interface GatewayServerConfig {
  host: string
  port: number
  apiKey: string
  autoStart: boolean
}

export interface PlaceholderProviderConfig {
  enabled: boolean
  note: string
}

export interface KiroProviderConfig {
  enabled: boolean
  routeName?: string
  settings: KiroProviderSettings
}

export interface KiroProviderSettings {
  apiRegion?: string
  region: string
  vpnProxyUrl: string
  sqliteReadonly: boolean
  firstTokenTimeoutSeconds: number
  streamingReadTimeoutSeconds: number
  maxRetries: number
  accountRecoveryTimeoutSeconds: number
  accountMaxBackoffMultiplier: number
  probabilisticRetryChance: number
}

export interface KiroAccountConfig {
  id: string
  email?: string
  label?: string
  enabled: boolean
  path?: string
  refreshToken?: string
  accessToken?: string
  expiresAt?: string
  profileArn?: string
  clientId?: string
  clientSecret?: string
  region?: string
  apiRegion?: string
}

export interface GatewayHubState {
  version: 1
  providers: {
    kiro: KiroProviderState
    [name: string]: unknown
  }
}

export interface KiroProviderState {
  accounts: Record<string, AccountRuntimeState>
  currentAccountIndex: number
  logs: GatewayLogEntry[]
}

export type AccountStatus =
  | 'available'
  | 'cooling'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'auth_failed'
  | 'manual_disabled'

export type ResponseKind =
  | 'success'
  | 'rate_limit'
  | 'quota'
  | 'auth'
  | 'server_error'
  | 'network'
  | 'timeout'

export interface ClassifiedKiroError {
  kind: ResponseKind
  cooldownMs: number
  resetAtIso?: string
}

export interface AccountRuntimeState {
  failures: number
  lastFailureAt: number
  lastSuccessAt: number
  lastError?: string
  modelsCachedAt: number
  modelIds: string[]
  status: AccountStatus
  statusReason?: string
  statusUpdatedAt: number
  cooldownUntil?: number
  lastResponseKind?: ResponseKind
  stats: {
    totalRequests: number
    successfulRequests: number
    failedRequests: number
  }
}

export interface GatewayLogEntry {
  ts: number
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  provider?: string
  accountId?: string
}

export interface GatewayRequestContext {
  requestId: string
  apiFormat: 'openai' | 'anthropic'
}

export interface GatewayResponse {
  status: number
  headers?: Record<string, string>
  body?: unknown
  stream?: AsyncIterable<string | Uint8Array>
}

export interface ProviderModel {
  id: string
  provider: ProviderName
  ownedBy?: string
  description?: string
}

export interface ProviderStatus {
  name: string
  providerType: ProviderName
  enabled: boolean
  configured: boolean
  status: 'ready' | 'disabled' | 'error' | 'placeholder'
  message?: string
  models: string[]
}

export interface ProviderAdapter {
  readonly name: ProviderName
  listModels(): Promise<ProviderModel[]>
  chatCompletions(body: any, context: GatewayRequestContext): Promise<GatewayResponse>
  messages(body: any, context: GatewayRequestContext): Promise<GatewayResponse>
  countTokens?(body: any, context: GatewayRequestContext): Promise<GatewayResponse>
  testAccount?(accountId: string): Promise<AccountTestResult>
  getStatus?(): Promise<ProviderStatus>
}

export interface AccountTestResult {
  ok: boolean
  accountId: string
  message: string
  models?: string[]
  expiresAt?: string
  authType?: string
}

export interface GatewayStatusSnapshot {
  server: {
    running: boolean
    url: string
    host: string
    port: number
    apiKey: string
  }
  configPath: string
  statePath: string
  providers: ProviderStatus[]
  logs: GatewayLogEntry[]
}
