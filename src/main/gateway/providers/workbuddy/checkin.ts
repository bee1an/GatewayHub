import type { WorkBuddyAccountConfig, WorkBuddyProviderSettings } from '../../types'
import { toErrorMessage } from '../../core/utils'
import {
  DEFAULT_WORKBUDDY_BACKEND,
  DEFAULT_WORKBUDDY_BILLING_HOSTS,
  WORKBUDDY_CHECKIN_CLAIM_PATH,
  WORKBUDDY_CHECKIN_STATUS_LEGACY_PATH,
  WORKBUDDY_CHECKIN_STATUS_PATH,
  WORKBUDDY_CREDITS_SUMMARY_PATH
} from './constants'
import { buildWorkBuddyHeaders } from './client'
import { joinUrl, workBuddyFetch } from './http'

export interface WorkBuddyCheckinStatus {
  checkedIn: boolean
  /** Total credits reported by checkin-status (total_credits). */
  totalCredits?: number
  streakDays?: number
  /** Whether the check-in activity is currently running. */
  active: boolean
}

export class WorkBuddyCheckinError extends Error {
  constructor(
    message: string,
    public readonly status = 0,
    public readonly code?: number | string
  ) {
    super(message)
    this.name = 'WorkBuddyCheckinError'
  }
}

/** YYYY-MM-DD in Asia/Shanghai — CN check-in resets on Beijing calendar days. */
export function cnDayKey(now = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now)
}

/**
 * Billing-meter check-in. The current desktop app queries
 * `checkin-activity-status` (the older `checkin-status` can report an inactive
 * legacy activity, so it is only a 404 fallback). Hosts are tried in order
 * (copilot backend, then workbuddy.cn/codebuddy.cn); business errors
 * (already-claimed etc.) stop the fallback since the request did reach a live
 * backend.
 */
export async function getCheckinStatus(
  account: WorkBuddyAccountConfig,
  token: string,
  settings: WorkBuddyProviderSettings
): Promise<WorkBuddyCheckinStatus> {
  let payload: any
  try {
    ;({ payload } = await billingPost(account, token, settings, WORKBUDDY_CHECKIN_STATUS_PATH))
  } catch (error) {
    if (!(error instanceof WorkBuddyCheckinError) || error.status !== 404) throw error
    // Older deployments only expose the legacy checkin-status route.
    ;({ payload } = await billingPost(
      account,
      token,
      settings,
      WORKBUDDY_CHECKIN_STATUS_LEGACY_PATH
    ))
  }
  const data = payload?.data ?? payload?.Data ?? payload
  return {
    checkedIn: Boolean(data?.today_checked_in ?? data?.todayCheckedIn),
    totalCredits: toCountOrUndef(data?.total_credits ?? data?.totalCredits),
    streakDays: toCountOrUndef(data?.streak_days ?? data?.streakDays),
    active: data?.active !== false
  }
}

/**
 * Real credit balance: `POST /billing/meter/get-user-resource-summary` (no /v2
 * prefix — this route family sits directly on the gateway). Sums
 * CycleRemainCapacity across credits-denominated packages; check-in activity
 * credits (total_credits) are a separate wallet, not account balance.
 */
export async function getCreditsUsage(
  account: WorkBuddyAccountConfig,
  token: string,
  settings: WorkBuddyProviderSettings
): Promise<number | undefined> {
  const { payload } = await billingPost(account, token, settings, WORKBUDDY_CREDITS_SUMMARY_PATH)
  const packages = payload?.data?.Packages ?? payload?.data?.packages
  if (!Array.isArray(packages)) return undefined
  let total = 0
  let found = false
  for (const pkg of packages) {
    const unit = String(pkg?.CapacityUnit ?? pkg?.capacity_unit ?? '')
    if (unit && unit !== 'credits') continue
    const remain = Number(pkg?.CycleRemainCapacity ?? pkg?.cycle_remain_capacity)
    if (!Number.isFinite(remain)) continue
    total += remain
    found = true
  }
  return found ? Math.round(total) : undefined
}

export async function claimCheckin(
  account: WorkBuddyAccountConfig,
  token: string,
  settings: WorkBuddyProviderSettings
): Promise<{ alreadyCheckedIn: boolean; credits?: number }> {
  const { payload } = await billingPost(account, token, settings, WORKBUDDY_CHECKIN_CLAIM_PATH, {
    tolerateAlreadyCheckedIn: true
  })
  const data = payload?.data ?? payload?.Data ?? {}
  const code = Number(payload?.code ?? 0)
  const msg = String(payload?.msg ?? '')
  return {
    alreadyCheckedIn: code === 10001 || /已签到/.test(msg),
    credits: toCountOrUndef(
      data?.credit ?? data?.today_credit ?? data?.daily_credit ?? data?.total_credits
    )
  }
}

async function billingPost(
  account: WorkBuddyAccountConfig,
  token: string,
  settings: WorkBuddyProviderSettings,
  path: string,
  opts?: { tolerateAlreadyCheckedIn?: boolean }
): Promise<{ payload: any; host: string }> {
  const hosts = billingHosts(account, settings)
  let lastError: unknown
  for (const host of hosts) {
    const response = await workBuddyFetch(
      joinUrl(`https://${host}`, path),
      {
        method: 'POST',
        headers: { ...buildWorkBuddyHeaders(account, token), 'x-domain': host },
        body: '{}',
        signal: AbortSignal.timeout(20_000)
      },
      settings
    ).catch((error) => {
      lastError = error
      return undefined
    })
    if (!response) continue
    const text = await response.text().catch((error) => toErrorMessage(error))
    let payload: any = {}
    try {
      payload = text ? JSON.parse(text) : {}
    } catch {
      payload = { rawText: text }
    }
    const code = payload?.code ?? payload?.Code
    const msg = String(payload?.msg ?? payload?.message ?? '')
    const businessError = code !== undefined && code !== null && code !== 0 && code !== '0'
    if (businessError) {
      // Already-claimed is a valid terminal state, not a failure.
      if (opts?.tolerateAlreadyCheckedIn && (code === 10001 || /已签到/.test(msg))) {
        return { payload, host }
      }
      throw new WorkBuddyCheckinError(
        `WorkBuddy check-in request failed: HTTP ${response.status} ${text.slice(0, 500)}`.trim(),
        response.status,
        typeof code === 'number' || typeof code === 'string' ? code : undefined
      )
    }
    if (!response.ok) {
      lastError = new WorkBuddyCheckinError(
        `WorkBuddy check-in HTTP ${response.status}: ${text.slice(0, 500)}`,
        response.status
      )
      continue
    }
    return { payload, host }
  }
  throw lastError instanceof Error
    ? lastError
    : new WorkBuddyCheckinError(`WorkBuddy check-in failed: ${toErrorMessage(lastError)}`)
}

function billingHosts(
  account: WorkBuddyAccountConfig,
  settings: WorkBuddyProviderSettings
): string[] {
  const configured = Array.isArray(settings.billingHosts) ? settings.billingHosts : []
  const backendHost = backendHostName(settings)
  const hosts = [backendHost, account.domain, ...configured, ...DEFAULT_WORKBUDDY_BILLING_HOSTS]
  return [...new Set(hosts.filter((h): h is string => typeof h === 'string' && !!h.trim()))]
}

function backendHostName(settings: WorkBuddyProviderSettings): string | undefined {
  try {
    const host = new URL(settings.backend || DEFAULT_WORKBUDDY_BACKEND).hostname
    return host || undefined
  } catch {
    return undefined
  }
}

function toCountOrUndef(value: unknown): number | undefined {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.round(numeric) : undefined
}
