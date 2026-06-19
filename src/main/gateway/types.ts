export type ProviderName =
  | 'kiro'
  | 'codex'
  | 'windsurf'
  | 'trae'
  | 'openrouter'
  | 'nvidia'
  | 'gptWeb'
  | 'grokWeb'
  | 'qoder'
  | 'gemini'
  | string

export interface GatewayHubConfig {
  version: number
  server: GatewayServerConfig
  defaultProvider: ProviderName
  providers: {
    kiro: KiroProviderConfig
    codex: CodexProviderConfig
    windsurf: WindsurfProviderConfig
    trae: TraeProviderConfig
    openrouter: OpenRouterProviderConfig
    nvidia: NvidiaProviderConfig
    gptWeb: GptWebProviderConfig
    grokWeb: GrokWebProviderConfig
    qoder: QoderProviderConfig
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
  /** Global HTTP/SOCKS5 proxy URL applied to providers whose `useProxy` is on. */
  proxyUrl: string
}

export interface PlaceholderProviderConfig {
  enabled: boolean
  routeName?: string
  displayName?: string
  note: string
}

export interface KiroProviderConfig {
  enabled: boolean
  /** When true, this gateway routes upstream requests through the global server.proxyUrl. Defaults to false. */
  useProxy?: boolean
  routeName?: string
  displayName?: string
  settings: KiroProviderSettings
}

export interface KiroProviderSettings {
  apiRegion?: string
  region: string
  /**
   * Runtime-injected proxy URL. Not user-configured — resolved from the global
   * `server.proxyUrl` + this provider's `useProxy` flag by the registry on rebuild.
   */
  vpnProxyUrl: string
  sqliteReadonly: boolean
  firstTokenTimeoutSeconds: number
  streamingReadTimeoutSeconds: number
  maxRetries: number
  /** Total concurrent Kiro upstream requests allowed in this process. */
  maxConcurrentRequests: number
  /** Concurrent large-prompt Kiro upstream requests allowed in this process. */
  maxConcurrentLargePromptRequests: number
  /** Request JSON byte length threshold for large-prompt throttling. */
  largePromptBytes: number
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
  /** When true, this gateway routes upstream requests through the global server.proxyUrl. Defaults to false. */
  useProxy?: boolean
  routeName?: string
  displayName?: string
  settings: CodexProviderSettings
}

export interface CodexProviderSettings {
  /** ChatGPT 后端 base URL，默认 https://chatgpt.com/backend-api */
  baseUrl: string
  /**
   * Runtime-injected proxy URL. Not user-configured — resolved from the global
   * `server.proxyUrl` + this provider's `useProxy` flag by the registry on rebuild.
   */
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
  /** OAuth id_token（含 gptWeb_account_id 等 claims） */
  idToken?: string
  /** GptWeb 后端账号 ID（来自 id_token 的 auth.chatgpt_account_id claim） */
  gptWebAccountId?: string
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
  /** When true, this gateway routes upstream requests through the global server.proxyUrl. Defaults to false. */
  useProxy?: boolean
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
  /**
   * Runtime-injected proxy URL passed to Windsurf language_server via proxy env vars.
   * Not user-configured — resolved from the global `server.proxyUrl` + this provider's
   * `useProxy` flag by the registry on rebuild.
   */
  vpnProxyUrl: string
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

export interface TraeProviderConfig {
  enabled: boolean
  /** When true, this gateway routes upstream requests through the global server.proxyUrl. Defaults to false. */
  useProxy?: boolean
  routeName?: string
  displayName?: string
  settings: TraeProviderSettings
}

export interface TraeProviderSettings {
  /** Trae auth/account base URL, defaults to https://grow-normal.traeapi.us */
  authBaseUrl: string
  /** Trae IDE core base URL, defaults to https://core-normal.traeapi.us */
  coreBaseUrl: string
  /** Trae OAuth client id observed from the international IDE product config */
  clientId: string
  /** Raw chat endpoint path; left configurable because Trae may move schemas */
  rawChatPath: string
  /** Prefer Trae's local renderer → ai-agent bridge for chat. This matches the official IDE path. */
  localChatEnabled: boolean
  /** Chrome DevTools Protocol port for a Trae window launched with --remote-debugging-port. */
  localDebugPort: number
  /** Trae.app path used when GatewayHub needs to launch a debuggable local bridge. */
  localAppPath: string
  /** Model list endpoint path observed in Trae IDE */
  modelListPath: string
  /**
   * Runtime-injected proxy URL. Not user-configured — resolved from the global
   * `server.proxyUrl` + this provider's `useProxy` flag by the registry on rebuild.
   */
  vpnProxyUrl: string
  ideVersion: string
  productVersion: string
  firstTokenTimeoutSeconds: number
  streamingReadTimeoutSeconds: number
  maxRetries: number
  /** Show docs-listed models that Trae marks unavailable for US users */
  exposeUnavailableInUS: boolean
}

export interface TraeAccountConfig {
  id: string
  label?: string
  email?: string
  enabled: boolean
  path?: string
  /** Cloud-IDE-JWT token used by Trae IDE requests */
  jwtToken?: string
  /** Trae refresh token accepted by /cloudide/api/v3/trae/oauth/ExchangeToken */
  refreshToken?: string
  tokenExpiresAt?: number
  refreshExpiresAt?: number
  userId?: string
  countryCode?: string
  authType?: string
  authBaseUrl?: string
  coreBaseUrl?: string
}

export interface OpenRouterProviderConfig {
  enabled: boolean
  routeName?: string
  displayName?: string
  settings: OpenRouterProviderSettings
}

export interface OpenRouterProviderSettings {
  /** OpenRouter API base URL, defaults to https://openrouter.ai/api/v1 */
  baseUrl: string
  firstTokenTimeoutSeconds: number
  streamingReadTimeoutSeconds: number
  maxRetries: number
  /** Race multiple API keys for a single request and use the first successful response. */
  requestRaceEnabled: boolean
  /** Max concurrent upstream API keys per inbound request when request racing is enabled. */
  requestRaceMaxConcurrent: number
}

export interface OpenRouterAccountConfig {
  id: string
  label?: string
  enabled: boolean
  path?: string
  apiKey?: string
  keyLabel?: string
  isFreeTier?: boolean
  limit?: number | null
  limitRemaining?: number | null
  usage?: number
  lastKeyInfoAt?: number
}

export interface OpenRouterProviderState {
  accounts: Record<string, AccountRuntimeState>
  currentAccountIndex: number
  logs: GatewayLogEntry[]
}

export interface NvidiaProviderConfig {
  enabled: boolean
  routeName?: string
  displayName?: string
  settings: NvidiaProviderSettings
}

export interface NvidiaProviderSettings {
  /** NVIDIA hosted NIM OpenAI-compatible API base URL */
  baseUrl: string
  firstTokenTimeoutSeconds: number
  streamingReadTimeoutSeconds: number
  maxRetries: number
  /** Race multiple API keys for a single request and use the first successful response. */
  requestRaceEnabled: boolean
  /** Max concurrent upstream API keys per inbound request when request racing is enabled. */
  requestRaceMaxConcurrent: number
}

export interface NvidiaAccountConfig {
  id: string
  label?: string
  enabled: boolean
  path?: string
  apiKey?: string
  keyLabel?: string
  lastKeyInfoAt?: number
}

export interface NvidiaProviderState {
  accounts: Record<string, AccountRuntimeState>
  currentAccountIndex: number
  logs: GatewayLogEntry[]
}

export interface GptWebProviderConfig {
  enabled: boolean
  /** When true, this gateway routes upstream requests through the global server.proxyUrl. Defaults to false. */
  useProxy?: boolean
  routeName?: string
  displayName?: string
  settings: GptWebProviderSettings
}

export interface GptWebProviderSettings {
  /** GptWeb backend base URL */
  baseUrl: string
  /**
   * Runtime-injected proxy URL. Not user-configured — resolved from the global
   * `server.proxyUrl` + this provider's `useProxy` flag by the registry on rebuild.
   */
  vpnProxyUrl: string
  firstTokenTimeoutSeconds: number
  streamingReadTimeoutSeconds: number
  maxRetries: number
}

export interface GptWebAccountConfig {
  id: string
  label?: string
  email?: string
  enabled: boolean
  path?: string
  accessToken?: string
  sessionToken?: string
  accountId: string
  planType?: string
  expiresAt?: string
  oaiDeviceId: string
  name?: string
}

export interface GptWebProviderState {
  accounts: Record<string, AccountRuntimeState>
  currentAccountIndex: number
  logs: GatewayLogEntry[]
}

export interface GrokWebProviderConfig {
  enabled: boolean
  /** When true, this gateway routes upstream requests through the global server.proxyUrl. Defaults to false. */
  useProxy?: boolean
  routeName?: string
  displayName?: string
  settings: GrokWebProviderSettings
}

export interface GrokWebProviderSettings {
  /** Grok Web base URL */
  baseUrl: string
  /** Grok Web gateway WebSocket URL */
  wsUrl: string
  /**
   * Runtime-injected proxy URL. Not user-configured — resolved from the global
   * `server.proxyUrl` + this provider's `useProxy` flag by the registry on rebuild.
   */
  vpnProxyUrl: string
  firstTokenTimeoutSeconds: number
  streamingReadTimeoutSeconds: number
  maxRetries: number
}

export interface GrokWebAccountConfig {
  id: string
  label?: string
  email?: string
  enabled: boolean
  path?: string
  /** Browser Cookie header for grok.com. Do not log or expose this value. */
  cookieHeader: string
  userId?: string
  grokDeviceId?: string
  planType?: string
  name?: string
}

export interface GrokWebProviderState {
  accounts: Record<string, AccountRuntimeState>
  currentAccountIndex: number
  logs: GatewayLogEntry[]
}

export interface QoderProviderConfig {
  enabled: boolean
  /** When true, this gateway routes upstream requests through the global server.proxyUrl. Defaults to false. */
  useProxy?: boolean
  routeName?: string
  displayName?: string
  settings: QoderProviderSettings
}

export interface QoderProviderSettings {
  /** Qoder model-server base URL. Gateway API requests go directly here with the account token. */
  apiBaseUrl: string
  /** qodercli binary path, used only to import auth and extract embedded Qoder auth WASM; GatewayHub never spawns it for chat requests. */
  qoderCliPath: string
  /**
   * Runtime-injected proxy URL used by direct Qoder HTTP requests. Not user-configured —
   * resolved from the global `server.proxyUrl` + this provider's `useProxy` flag by the
   * registry on rebuild.
   */
  vpnProxyUrl: string
  firstTokenTimeoutSeconds: number
  streamingReadTimeoutSeconds: number
  maxRetries: number
  /** Default max_tokens sent to Qoder model server when the client omits max_tokens. */
  maxOutputTokens: '16k' | '32k'
}

export interface QoderAccountConfig {
  id: string
  label?: string
  email?: string
  enabled: boolean
  path?: string
  /**
   * Authentication source.
   * `qoder-personal-access-token` is exchanged for a Qoder access token and used directly over HTTP.
   * `qoder-cli-auth` / `qoder-cli-login` point at an imported local auth bundle; GatewayHub reads
   * the encrypted token file directly and never spawns qodercli in the request path.
   * `qoder-cli-login` is accepted only as a legacy config value.
   */
  authType?: 'qoder-personal-access-token' | 'qoder-cli-auth' | 'qoder-cli-login'
  /** Qoder Personal Access Token, sent directly as Authorization: Bearer <token>. */
  personalAccessToken?: string
  /** GatewayHub-managed QODER_CLI_HOME for CLI-login accounts. */
  qoderCliHome?: string
  /** Optional per-account qodercli binary path. */
  qoderCliPath?: string
}

export interface QoderProviderState {
  accounts: Record<string, AccountRuntimeState>
  currentAccountIndex: number
  logs: GatewayLogEntry[]
}

export interface GatewayHubState {
  version: 1
  providers: {
    kiro: KiroProviderState
    codex: CodexProviderState
    windsurf: WindsurfProviderState
    trae: TraeProviderState
    openrouter: OpenRouterProviderState
    nvidia: NvidiaProviderState
    gptWeb: GptWebProviderState
    grokWeb: GrokWebProviderState
    qoder: QoderProviderState
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

export interface TraeProviderState {
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

/**
 * Common core of every per-provider account config. Every `XxxAccountConfig`
 * in this file extends this shape (id / label / email / enabled / path).
 * Used by the generic `AccountFileStore<T>` so CRUD logic can be shared.
 */
export interface BaseAccountConfig {
  id: string
  label?: string
  email?: string
  enabled: boolean
  path?: string
}

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
  raceStats?: AccountRaceStats
}

export interface AccountRaceStats {
  attempts: number
  successes: number
  failures: number
  ewmaLatencyMs?: number
  successRateEwma?: number
  lastUpdatedAt?: number
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
  /**
   * Stable conversation/session identifier.
   * Unlike requestId, this should stay constant across turns in the same client session.
   */
  sessionId?: string
  sessionSource?: 'body' | 'metadata' | 'header' | 'fallback' | 'request'
  apiFormat: 'openai' | 'anthropic'
  onUsage?: (usage: UsageStats, meta?: UsageMeta) => void
  abortSignal?: AbortSignal
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
  /** Present for providers that support the global proxy toggle; reflects `useProxy`. */
  useProxy?: boolean
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
  // Account-management surface (implemented by delegating to the pool).
  // Declared here so the registry can call without `as any`.
  getAccountInfo?(accountId: string): Promise<any>
  refreshAccountModels?(accountId: string): Promise<any>
  resetAccount?(accountId: string): Promise<void>
  setAccountStatus?(accountId: string, status: AccountStatus, reason?: string): Promise<void>
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
