export type ProviderName = 'kiro' | 'codex' | 'windsurf' | 'gemini' | string

export interface GatewayHubConfig {
  version: number
  server: GatewayServerConfig
  defaultProvider: ProviderName
  providers: {
    kiro: KiroProviderConfig
    codex: CodexProviderConfig
    windsurf: WindsurfProviderConfig
    gemini: PlaceholderProviderConfig
    [name: string]: unknown
  }
  modelMappings: ModelMapping[]
}

export interface ModelMapping {
  alias: string
  provider: ProviderName
  model: string
  enabled: boolean
  note?: string
}

export interface ApiKeyEntry {
  id: string
  key: string
  name: string
  createdAt: number
  lastUsedAt?: number
  expiresAt?: number
  scopes?: string[]
}

export interface GatewayServerConfig {
  host: string
  port: number
  apiKeys: ApiKeyEntry[]
  autoStart: boolean
}

export interface PlaceholderProviderConfig {
  enabled: boolean
  routeName?: string
  displayName?: string
  note: string
}

export interface KiroProviderConfig {
  enabled: boolean
  routeName?: string
  displayName?: string
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

export interface CodexProviderConfig {
  enabled: boolean
  routeName?: string
  displayName?: string
  settings: CodexProviderSettings
}

export interface CodexProviderSettings {
  /** ChatGPT 后端 base URL，默认 https://chatgpt.com/backend-api */
  baseUrl: string
  /** HTTP/SOCKS5 代理 URL */
  vpnProxyUrl: string
  firstTokenTimeoutSeconds: number
  streamingReadTimeoutSeconds: number
  maxRetries: number
  /** OAuth callback 端口，默认 1455 */
  callbackPort: number
  /** access_token 提前刷新窗口（秒） */
  refreshSkewSeconds: number
  /** 强制 last_refresh 过期时间（秒） */
  refreshIntervalSeconds: number
}

/** Codex 凭据结构（兼容官方 codex CLI 的 ~/.codex/auth.json） */
export interface CodexAccountConfig {
  id: string
  /** 账号显示标签（用户可改） */
  label?: string
  /** 来自 id_token 的 email；用于 UI 展示和去重 */
  email?: string
  enabled: boolean
  path?: string
  /** OAuth refresh token */
  refreshToken?: string
  /** OAuth access token（短期 JWT） */
  accessToken?: string
  /** OAuth id_token（含 chatgpt_account_id 等 claims） */
  idToken?: string
  /** ChatGPT 后端账号 ID（来自 id_token 的 auth.chatgpt_account_id claim） */
  chatgptAccountId?: string
  /** 上次 token 刷新的 ISO 时间 */
  lastRefresh?: string
  /** access_token 解码出的 exp（毫秒） */
  expiresAt?: number
  /** 订阅过期时间 ISO（来自 id_token） */
  subscriptionActiveUntil?: string
  /** 用户名 */
  name?: string
}

export interface WindsurfProviderConfig {
  enabled: boolean
  routeName?: string
  displayName?: string
  settings: WindsurfProviderSettings
}

export interface WindsurfProviderSettings {
  /** Windsurf / Codeium API server，默认 https://server.self-serve.windsurf.com */
  apiServerUrl: string
  /** Windsurf / Codeium inference server，默认 https://inference.codeium.com */
  inferenceApiServerUrl: string
  /** Windsurf language_server 二进制路径；为空时自动探测本机 Windsurf.app */
  languageServerBinaryPath: string
  /** 传给 language_server 的 codeium_dir，默认 .codeium/windsurf */
  codeiumDir: string
  firstTokenTimeoutSeconds: number
  streamingReadTimeoutSeconds: number
  launchTimeoutSeconds: number
  maxRetries: number
  detectProxy: boolean
}

/** Windsurf 凭据：Windsurf Auth session/accessToken，也就是 language server metadata.api_key */
export interface WindsurfAccountConfig {
  id: string
  label?: string
  email?: string
  enabled: boolean
  path?: string
  apiKey?: string
  apiServerUrl?: string
  inferenceApiServerUrl?: string
  authType?: string
}

export interface GatewayHubState {
  version: 1
  providers: {
    kiro: KiroProviderState
    codex: CodexProviderState
    windsurf: WindsurfProviderState
    [name: string]: unknown
  }
}

export interface KiroProviderState {
  accounts: Record<string, AccountRuntimeState>
  currentAccountIndex: number
  logs: GatewayLogEntry[]
}

export interface CodexProviderState {
  accounts: Record<string, AccountRuntimeState>
  currentAccountIndex: number
  logs: GatewayLogEntry[]
}

export interface WindsurfProviderState {
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
  | 'model_error'
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

export type LogCategory = 'system' | 'auth' | 'request' | 'upstream' | 'account'

export interface UsageStats {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWrite5mTokens?: number
  cacheWrite1hTokens?: number
  /** 上游网关的原生计费单位（Kiro 用 credit）。优先级高于 token 价格 */
  credits?: number
  estimated?: boolean
}

export interface CostStats {
  inputUsd: number
  outputUsd: number
  cacheReadUsd: number
  cacheWriteUsd: number
  /** 按 credit 计价时的费用；非 credit 网关恒为 0 */
  creditsUsd: number
  totalUsd: number
  currency: 'USD'
  /** true 表示价格表覆盖了该模型；false/undefined 表示该模型未在价格表中 */
  known?: boolean
  /** 计价模式：credit = 按上游 credit 计费；token = 按模型 token 单价计费 */
  basis: 'credit' | 'token' | 'none'
}

/** 单日用量聚合：一个账户/模型在某天的累计 token 数 */
export interface UsageDailyEntry {
  date: string // YYYY-MM-DD（本地时区）
  accountId: string
  model: string
  /** 来源网关（kiro/codex/...）；用于前端选择 token 还是 credit 视图 */
  provider?: ProviderName
  apiFormat?: 'openai' | 'anthropic'
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
  /** 累计 credit 数（kiro 网关有效，其他网关恒为 0） */
  credits: number
  requests: number
  costUsd: number | null // null 表示模型未定价
  /** 计价模式：credit / token / none */
  costBasis: 'credit' | 'token' | 'none'
  updatedAt: string
}

export interface UsageReadOptions {
  sinceKey?: string
  untilKey?: string
  accountId?: string
  model?: string
  provider?: ProviderName
}

export interface UsageSummary {
  todayTokens: number
  todayCredits: number
  todayCostUsd: number | null
  last30DaysTokens: number
  last30DaysCredits: number
  last30DaysCostUsd: number | null
  todayInputTokens: number
  todayOutputTokens: number
  todayCacheReadTokens: number
  todayCacheWriteTokens: number
  todayRequests: number
  updatedAt: string
}

export interface UsageDetail {
  summary: UsageSummary
  daily: UsageDailyEntry[]
}

export interface GatewayLogEntry {
  ts: number
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  provider?: string
  accountId?: string
  requestId?: string
  category?: LogCategory
  statusCode?: number
  duration?: number
  streaming?: boolean
  timeToFirstToken?: number
  chunkCount?: number
  model?: string
  apiFormat?: 'openai' | 'anthropic'
  usage?: UsageStats
  cost?: CostStats
  error?: { stack?: string; upstreamBody?: string }
  extra?: Record<string, unknown>
}

export interface GatewayRequestContext {
  requestId: string
  apiFormat: 'openai' | 'anthropic'
  onUsage?: (usage: UsageStats, meta?: UsageMeta) => void
}

export interface UsageMeta {
  accountId?: string
  model?: string
  provider?: ProviderName
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
  displayName?: string
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
  dispose?(): Promise<void> | void
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
    apiKeys: ApiKeyEntry[]
  }
  configPath: string
  statePath: string
  providers: ProviderStatus[]
  logs: GatewayLogEntry[]
}
