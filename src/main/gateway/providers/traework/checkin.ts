import type { TraeWorkAccountConfig, TraeWorkProviderSettings } from '../../types'
import { toErrorMessage } from '../../core/utils'
import { DEFAULT_TRAEWORK_AUTH_BASE_URL } from './constants'
import { joinUrl, traeWorkFetch } from './http'

export const TRAEWORK_CHECKIN_STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status'
export const TRAEWORK_CHECKIN_CLAIM_PATH = '/trae/api/v2/ug/checkin_credits/claim'
export const TRAEWORK_ENT_USAGE_PATH = '/trae/api/v2/pay/ide_user_ent_usage'

export interface TraeWorkCheckinStatus {
  checkedIn: boolean
  /** Credits granted by the daily check-in (e.g. 150), or today's claimed amount. */
  credits: number
  /** Bonus credits on top of `credits` (e.g. streak bonus, +50). */
  extraCredits: number
  /** Whether the check-in activity is available for this account. */
  enable: boolean
}

/** YYYY-MM-DD in Asia/Shanghai — Trae CN check-in resets on Beijing calendar days. */
export function cnDayKey(now = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now)
}

export class TraeWorkCheckinError extends Error {
  constructor(
    message: string,
    public readonly status = 0,
    public readonly code?: number | string
  ) {
    super(message)
    this.name = 'TraeWorkCheckinError'
  }
}

/**
 * Header set for the api.trae.cn "ug" surface (check-in + entitlement usage).
 * X-Device-Id/X-Machine-Id are required — without them the API rejects with
 * code 9004. X-User-Region must be CN for the SOLO CN build.
 */
function buildUgHeaders(account: TraeWorkAccountConfig, token: string): Record<string, string> {
  const deviceId = account.deviceId || account.devDeviceId || ''
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Cloud-IDE-JWT ${token}`,
    'x-cloudide-token': token,
    'x-user-region': account.countryCode || 'CN',
    'user-agent': 'TraeClient/TTNet'
  }
  if (deviceId) headers['x-device-id'] = deviceId
  if (account.machineId) headers['x-machine-id'] = account.machineId
  if (account.userId) headers['x-uid'] = account.userId
  return headers
}

async function ugPost(
  account: TraeWorkAccountConfig,
  token: string,
  settings: TraeWorkProviderSettings,
  path: string
): Promise<any> {
  const base = account.authBaseUrl || settings.authBaseUrl || DEFAULT_TRAEWORK_AUTH_BASE_URL
  const response = await traeWorkFetch(
    joinUrl(base, path),
    {
      method: 'POST',
      headers: buildUgHeaders(account, token),
      body: '{}',
      signal: AbortSignal.timeout(20_000)
    },
    settings
  )
  const text = await response.text().catch((error) => toErrorMessage(error))
  let payload: any = {}
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    payload = { rawText: text }
  }
  const code = payload?.code ?? payload?.Code ?? payload?.error?.code
  const failed =
    !response.ok ||
    (code !== undefined &&
      code !== null &&
      !(code === 0 || code === '0' || code === 'OK' || code === 'ok'))
  if (failed) {
    const detail = typeof text === 'string' && text.length > 500 ? text.slice(0, 500) : text
    throw new TraeWorkCheckinError(
      `TraeWork check-in request failed: HTTP ${response.status} ${detail || ''}`.trim(),
      response.status,
      typeof code === 'number' || typeof code === 'string' ? code : undefined
    )
  }
  return payload?.Result ?? payload?.result ?? payload
}

export async function getCheckinStatus(
  account: TraeWorkAccountConfig,
  token: string,
  settings: TraeWorkProviderSettings
): Promise<TraeWorkCheckinStatus> {
  const payload = await ugPost(account, token, settings, TRAEWORK_CHECKIN_STATUS_PATH)
  return {
    checkedIn: Boolean(payload?.checked_in ?? payload?.checkedIn),
    credits: toCount(payload?.credits ?? payload?.Credits),
    extraCredits: toCount(payload?.extra_credits ?? payload?.extraCredits),
    enable: payload?.enable !== false && payload?.Enable !== false
  }
}

/**
 * Claims today's check-in credits. Returns the granted credit amount when the
 * server reports it; callers should re-query status for the authoritative total.
 */
export async function claimCheckin(
  account: TraeWorkAccountConfig,
  token: string,
  settings: TraeWorkProviderSettings
): Promise<number | undefined> {
  const payload = await ugPost(account, token, settings, TRAEWORK_CHECKIN_CLAIM_PATH)
  const credits = payload?.credits ?? payload?.Credits
  return credits === undefined ? undefined : toCount(credits)
}

/**
 * Remaining credits from ide_user_ent_usage. Prefers usage_summary
 * (total_amount − consumed_amount); falls back to summing pack credits_limit.
 */
export async function getCreditsUsage(
  account: TraeWorkAccountConfig,
  token: string,
  settings: TraeWorkProviderSettings
): Promise<number | undefined> {
  const payload = await ugPost(account, token, settings, TRAEWORK_ENT_USAGE_PATH)
  const summary = payload?.usage_summary ?? payload?.usageSummary
  const total = Number(summary?.total_amount ?? summary?.totalAmount)
  const consumed = Number(summary?.consumed_amount ?? summary?.consumedAmount)
  if (Number.isFinite(total) && total > 0) {
    return Math.max(0, Math.round(total - (Number.isFinite(consumed) ? consumed : 0)))
  }
  const packs = payload?.user_entitlement_pack_list ?? payload?.userEntitlementPackList
  if (!Array.isArray(packs)) return undefined
  let sum = 0
  for (const pack of packs) {
    const quota = pack?.entitlement_base_info?.quota ?? pack?.entitlementBaseInfo?.quota
    sum += toCount(quota?.credits_limit ?? quota?.creditsLimit)
  }
  return sum
}

function toCount(value: unknown): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : 0
}
