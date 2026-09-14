import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewayLogger } from '../../../core/logger'
import { WorkBuddyAccountPool } from '../accountPool'
import {
  WorkBuddyCheckinError,
  claimCheckin,
  cnDayKey,
  getCheckinStatus,
  getCreditsUsage
} from '../checkin'
import { parseWorkBuddyAuthInput } from '../normalize'
import type {
  WorkBuddyAccountConfig,
  WorkBuddyProviderConfig,
  WorkBuddyProviderState
} from '../../../types'
import { DEFAULT_WORKBUDDY_SETTINGS } from '../constants'

const SETTINGS = { ...DEFAULT_WORKBUDDY_SETTINGS }

const ACCOUNT: WorkBuddyAccountConfig = {
  id: 'acc-1',
  label: 'wb user',
  enabled: true,
  accessToken: 'access-tok',
  refreshToken: 'refresh-tok',
  uid: 'uid-1',
  domain: 'www.workbuddy.cn'
}

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('workbuddy/normalize', () => {
  it('builds an account from a raw access token', () => {
    const accounts = parseWorkBuddyAuthInput('eyJhbGciOiJS.test')
    expect(accounts).toHaveLength(1)
    expect(accounts[0].accessToken).toBe('eyJhbGciOiJS.test')
    expect(accounts[0].domain).toBe('www.workbuddy.cn')
    expect(accounts[0].authType).toBe('workbuddy-token')
  })

  it('parses a pasted workbuddy-desktop.info document', () => {
    const info = {
      session: {
        auth: {
          accessToken: 'eyJ.acc',
          refreshToken: 'eyJ.ref',
          expiresAt: 1_800_000_000_000,
          domain: 'www.workbuddy.cn'
        },
        account: { uid: 'u-123', nickname: '13800001111', enterpriseId: 'e-9' }
      }
    }
    const accounts = parseWorkBuddyAuthInput(JSON.stringify(info))
    expect(accounts).toHaveLength(1)
    const acc = accounts[0]
    expect(acc.accessToken).toBe('eyJ.acc')
    expect(acc.refreshToken).toBe('eyJ.ref')
    expect(acc.uid).toBe('u-123')
    expect(acc.nickname).toBe('13800001111')
    expect(acc.enterpriseId).toBe('e-9')
    expect(acc.id).toContain('workbuddy-user-')
    expect(acc.authType).toBe('workbuddy-refresh-token')
  })

  it('returns [] for unusable input', () => {
    expect(parseWorkBuddyAuthInput('')).toEqual([])
    expect(parseWorkBuddyAuthInput('{}')).toEqual([])
    expect(parseWorkBuddyAuthInput('null')).toEqual([])
  })
})

describe('workbuddy/checkin endpoints', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('queries checkin-status with copilot headers on the billing host', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        code: 0,
        data: { today_checked_in: false, total_credits: 300, streak_days: 2, active: true }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const status = await getCheckinStatus(ACCOUNT, 'tok', SETTINGS)
    expect(status).toEqual({ checkedIn: false, totalCredits: 300, streakDays: 2, active: true })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    // The copilot backend is tried first; the desktop app queries
    // checkin-activity-status (checkin-status is the legacy fallback).
    expect(url).toBe('https://copilot.tencent.com/v2/billing/meter/checkin-activity-status')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer tok')
    expect(headers['x-user-id']).toBe('uid-1')
    expect(headers['x-domain']).toBe('copilot.tencent.com')
  })

  it('falls back to the legacy checkin-status path on 404', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any) => {
        const url = String(input)
        urls.push(url)
        if (url.includes('checkin-activity-status')) {
          return new Response(JSON.stringify({ error_msg: '404 Route Not Found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' }
          })
        }
        return jsonResponse({ code: 0, data: { today_checked_in: true, active: true } })
      })
    )
    const status = await getCheckinStatus(ACCOUNT, 'tok', SETTINGS)
    expect(status.checkedIn).toBe(true)
    expect(urls.some((u) => u.includes('/v2/billing/meter/checkin-status'))).toBe(true)
  })

  it('falls back to the codebuddy.cn host on network failure', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any) => {
        urls.push(String(input))
        if (urls.length <= 1) throw new Error('fetch failed: connect refused')
        return jsonResponse({ code: 0, data: { today_checked_in: true, active: true } })
      })
    )
    const status = await getCheckinStatus(ACCOUNT, 'tok', SETTINGS)
    expect(status.checkedIn).toBe(true)
    expect(urls[1]).toContain('workbuddy.cn')
  })

  it('throws WorkBuddyCheckinError on a non-zero business code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ code: 9004, msg: 'param error' }))
    )
    await expect(getCheckinStatus(ACCOUNT, 'tok', SETTINGS)).rejects.toBeInstanceOf(
      WorkBuddyCheckinError
    )
  })

  it('claimCheckin tolerates code 10001 (already checked in)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ code: 10001, msg: '已签到', data: {} }))
    )
    const result = await claimCheckin(ACCOUNT, 'tok', SETTINGS)
    expect(result.alreadyCheckedIn).toBe(true)
  })

  it('claimCheckin returns granted credits', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ code: 0, data: { today_credit: 100 } }))
    )
    await expect(claimCheckin(ACCOUNT, 'tok', SETTINGS)).resolves.toEqual({
      alreadyCheckedIn: false,
      credits: 100
    })
  })

  it('getCreditsUsage sums CycleRemainCapacity across credit packages', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        code: 0,
        data: {
          Packages: [
            {
              PackageCode: 'a',
              CycleTotalCapacity: '2000',
              CycleRemainCapacity: '2000',
              CapacityUnit: 'credits'
            },
            {
              PackageCode: 'b',
              CycleTotalCapacity: '500',
              CycleRemainCapacity: '499.7',
              CapacityUnit: 'credits'
            }
          ]
        }
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(getCreditsUsage(ACCOUNT, 'tok', SETTINGS)).resolves.toBe(2500)
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    // The resource-summary family has no /v2 prefix.
    expect(url).toBe('https://copilot.tencent.com/billing/meter/get-user-resource-summary')
  })

  it('cnDayKey returns a YYYY-MM-DD key in Asia/Shanghai', () => {
    expect(cnDayKey(Date.parse('2026-09-14T00:30:00+08:00'))).toBe('2026-09-14')
    expect(cnDayKey(Date.parse('2026-09-14T16:30:00Z'))).toBe('2026-09-15')
  })
})

describe('workbuddy/checkinAccounts', () => {
  const state: WorkBuddyProviderState = {
    accounts: {},
    currentAccountIndex: 0,
    logs: []
  } as WorkBuddyProviderState
  const config: WorkBuddyProviderConfig = {
    enabled: true,
    settings: SETTINGS
  } as WorkBuddyProviderConfig

  function makePool() {
    const logger = new GatewayLogger({ maxEntries: 10 })
    return new WorkBuddyAccountPool(config, state, logger, () => {})
  }

  beforeEach(() => {
    state.accounts = {}
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('claims when not yet checked in and records the day', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any) => {
        const url = String(input)
        calls.push(url)
        if (url.endsWith('/daily-checkin')) {
          return jsonResponse({ code: 0, data: { today_credit: 50 } })
        }
        const claimed = calls.filter((u) => u.endsWith('/daily-checkin')).length > 0
        return jsonResponse({
          code: 0,
          data: { today_checked_in: claimed, total_credits: 300, active: true }
        })
      })
    )

    const pool = makePool()
    await pool.reload([{ ...ACCOUNT }])
    const result = await pool.checkinAccounts()

    expect(result.claimed).toBe(1)
    expect(result.failed).toBe(0)
    expect(calls.some((u) => u.endsWith('/daily-checkin'))).toBe(true)
    expect(state.accounts['acc-1'].checkin).toMatchObject({
      lastDay: cnDayKey(),
      lastCredits: 300
    })
  })

  it('skips accounts already confirmed for the CN day', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ code: 0, data: { today_checked_in: true, total_credits: 300, active: true } })
    )
    vi.stubGlobal('fetch', fetchMock)

    const pool = makePool()
    await pool.reload([{ ...ACCOUNT }])
    await pool.checkinAccounts()
    const second = await pool.checkinAccounts()

    expect(second.skipped).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports inactive check-in activity as a skipped success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ code: 0, data: { today_checked_in: false, active: false } }))
    )
    const pool = makePool()
    await pool.reload([{ ...ACCOUNT }])
    const result = await pool.checkinAccounts()

    expect(result.skipped).toBe(1)
    expect(result.claimed).toBe(0)
    expect(state.accounts['acc-1'].checkin?.lastDay).toBe(cnDayKey())
  })

  it('records lastError on failure without marking the day done', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ code: 9074, msg: 'busy' }))
    )
    const pool = makePool()
    await pool.reload([{ ...ACCOUNT }])
    const result = await pool.checkinAccounts()

    expect(result.ok).toBe(false)
    expect(result.failed).toBe(1)
    const checkin = state.accounts['acc-1'].checkin
    expect(checkin?.lastError).toContain('9074')
    expect(checkin?.lastDay).toBeUndefined()
  })
})
