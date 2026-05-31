export type AccountFilter = 'all' | 'available' | 'problematic'

export type Provider = {
  name: string
  providerType: string
  displayName?: string
  enabled: boolean
  configured: boolean
  status: string
  message?: string
  models: string[]
  accounts?: Account[]
}

export type AccountStatus =
  | 'available'
  | 'cooling'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'auth_failed'
  | 'manual_disabled'

export type Account = {
  id: string
  label?: string
  type: string
  enabled: boolean
  path?: string
  failures: number
  lastError?: string
  lastSuccessAt?: number
  lastFailureAt?: number
  models?: string[]
  stats?: { totalRequests: number; successfulRequests: number; failedRequests: number }
  authType?: string
  expiresAt?: string
  status?: AccountStatus
  statusReason?: string
  statusUpdatedAt?: number
  cooldownUntil?: number
  lastResponseKind?: string
}

export type CodexRateLimitWindow = {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

export type AccountModel = {
  modelId: string
  modelName: string
  rateMultiplier: number
  rateUnit: string
}

export type AccountInfo = {
  subscription: { title: string; type: string }
  email?: string
  usage?: {
    used: number
    limit: number
    overages: number
    overageCap: number
    overageRate: number
    overageCharges: number
    resetDate: string
  }
  models: AccountModel[]
  error?: string
  /** codex 专属：5h primary / weekly secondary 速率窗口 */
  rateLimits?: {
    primary?: CodexRateLimitWindow
    secondary?: CodexRateLimitWindow
    planType?: string
    fetchedAt?: string
  }
}

export type GatewayStatus = {
  server: { running: boolean; url: string; host: string; port: number; apiKeys: any[] }
  configPath: string
  statePath: string
  providers: Provider[]
  logs: any[]
}
