import type { KiroAccountConfig } from '../../types'
import { sha256Short } from '../../core/utils'
import { kiroFetch } from './auth'
import { kiroRefreshUrl } from './constants'

export interface RawImportedAccount {
  refresh_token?: string
  refreshToken?: string
  access_token?: string
  accessToken?: string
  profile_arn?: string
  profileArn?: string
  api_region?: string
  apiRegion?: string
  region?: string
  expires_at?: string
  expiresAt?: string
  client_id?: string
  clientId?: string
  client_secret?: string
  clientSecret?: string
  label?: string
  email?: string
}

export interface NormalizedAccount {
  refreshToken: string
  accessToken?: string
  profileArn?: string
  region: string
  apiRegion?: string
  expiresAt?: string
  clientId?: string
  clientSecret?: string
  label?: string
  email?: string
}

export function normalizeImportedAccount(input: RawImportedAccount): NormalizedAccount | null {
  const refreshToken = input.refreshToken || input.refresh_token || ''
  const accessToken = input.accessToken || input.access_token || ''
  if (!refreshToken && !accessToken) return null

  return {
    refreshToken,
    accessToken: accessToken || undefined,
    profileArn: input.profileArn || input.profile_arn || undefined,
    region: input.region || 'us-east-1',
    apiRegion: input.apiRegion || input.api_region || undefined,
    expiresAt: input.expiresAt || input.expires_at || undefined,
    clientId: input.clientId || input.client_id || undefined,
    clientSecret: input.clientSecret || input.client_secret || undefined,
    label: input.label || undefined,
    email: input.email || undefined
  }
}

export async function resolveRefreshTokenAccount(
  account: NormalizedAccount,
  vpnProxyUrl?: string
): Promise<NormalizedAccount> {
  if (!account.refreshToken) return account

  const needsRefresh =
    !account.accessToken ||
    !account.expiresAt ||
    !account.profileArn ||
    isExpired(account.expiresAt)
  if (!needsRefresh) return account

  const response = await kiroFetch(
    kiroRefreshUrl(account.region || 'us-east-1'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: account.refreshToken })
    },
    vpnProxyUrl
  )

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Token refresh failed: HTTP ${response.status} ${body.slice(0, 300)}`)
  }

  const data = await response.json()
  return {
    ...account,
    refreshToken: data.refreshToken || data.refresh_token || account.refreshToken,
    accessToken: data.accessToken || data.access_token || account.accessToken,
    profileArn: data.profileArn || data.profile_arn || account.profileArn,
    expiresAt: new Date(
      Date.now() + Math.max(60, Number(data.expiresIn || data.expires_in || 3600) - 60) * 1000
    ).toISOString()
  }
}

export function buildKiroAccountConfig(account: NormalizedAccount): KiroAccountConfig {
  if (!account.refreshToken && account.accessToken) {
    const id = `kiro-access-${sha256Short(account.accessToken)}`
    return {
      id,
      enabled: true,
      label: account.label,
      email: account.email,
      accessToken: account.accessToken,
      expiresAt: account.expiresAt,
      profileArn: account.profileArn,
      clientId: account.clientId,
      clientSecret: account.clientSecret,
      region: account.region,
      apiRegion: account.apiRegion
    }
  }

  const id = account.profileArn
    ? `kiro-profile-${sha256Short(account.profileArn)}`
    : `kiro-refresh-${sha256Short(account.refreshToken)}`

  return {
    id,
    enabled: true,
    label: account.label,
    email: account.email,
    refreshToken: account.refreshToken,
    accessToken: account.accessToken,
    expiresAt: account.expiresAt,
    profileArn: account.profileArn,
    clientId: account.clientId,
    clientSecret: account.clientSecret,
    region: account.region,
    apiRegion: account.apiRegion
  }
}

function isExpired(expiresAt?: string): boolean {
  if (!expiresAt) return true
  const date = new Date(expiresAt)
  return isNaN(date.getTime()) || date.getTime() <= Date.now()
}
