export interface UsageLimitsResponse {
  subscriptionInfo: { title: string; type: string }
  usageBreakdownList: Array<{
    currentUsage: number
    usageLimit: number
    currentOverages: number
    overageCap: number
    overageRate: number
    overageCharges: number
  }>
  nextDateReset: string
  userInfo: { email?: string; userId?: string }
}

export interface AvailableModel {
  modelId: string
  modelName: string
  description: string
  rateMultiplier: number
  rateUnit: string
  tokenLimits: { inputTokenLimit: number; outputTokenLimit: number }
  promptCaching: boolean
}

export interface AvailableModelsResponse {
  models: AvailableModel[]
}

export interface AccountInfo {
  subscription: { title: string; type: string }
  email?: string
  usage: {
    used: number
    limit: number
    overages: number
    overageCap: number
    overageRate: number
    overageCharges: number
    resetDate: string
  }
  models: AvailableModel[]
  error?: string
}
