/** Codex 凭据原始 payload（与官方 ~/.codex/auth.json 兼容） */
export interface CodexAuthPayload {
  auth_mode?: string
  OPENAI_API_KEY?: string | null
  last_refresh?: string
  tokens?: {
    access_token?: string
    refresh_token?: string
    id_token?: string
    account_id?: string
  }
}

/** OAuth /token 响应 */
export interface CodexTokenResponse {
  access_token: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
  token_type?: string
}

/** 设备流登录响应 */
export interface CodexDeviceCodeResponse {
  device_auth_id: string
  user_code: string
  interval?: number
  expires_in?: number
}

export interface CodexAccountInfo {
  id: string
  email?: string
  name?: string
  chatgptAccountId?: string
  subscriptionActiveUntil?: string
  expiresAt?: number
  lastRefresh?: string
}

/** OAuth 登录流程的进度通知（送给前端用） */
export interface CodexLoginEvent {
  kind: 'pending' | 'authorize' | 'success' | 'error' | 'cancelled'
  message?: string
  authorizeUrl?: string
  /** 设备流的用户码 */
  userCode?: string
  /** 设备流的 verification URL（完整带 user_code） */
  verificationUri?: string
  /** 成功后写入的账户 ID */
  accountId?: string
}
