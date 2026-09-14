import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewayLogger } from '../../../core/logger'
import { TraeWorkAccountPool } from '../accountPool'
import {
  cnDayKey,
  claimCheckin,
  getCheckinStatus,
  getCreditsUsage,
  TraeWorkCheckinError
} from '../checkin'
import type {
  TraeWorkAccountConfig,
  TraeWorkProviderConfig,
  TraeWorkProviderState
} from '../../../types'
import { DEFAULT_TRAEWORK_SETTINGS } from '../constants'

const SETTINGS = { ...DEFAULT_TRAEWORK_SETTINGS }

const ACCOUNT: TraeWorkAccountConfig = {
  id: 'acc-1',
  email: 'user@example.com',
  enabled: true,
  jwtToken: 'jwt-token',
  userId: '1234',
  deviceId: 'device-1',
  machineId: 'machine-1'
}

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('traework/checkin endpoints', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('parses a flat checkin_credits status payload', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ checked_in: false, credits: 200, enable: true })
    )
    vi.stubGlobal('fetch', fetchMock)

    const status = await getCheckinStatus(ACCOUNT, 'tok', SETTINGS)
    expect(status).toEqual({ checkedIn: false, credits: 200, extraCredits: 0, enable: true })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.trae.cn/trae/api/v2/ug/checkin_credits/status')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Cloud-IDE-JWT tok')
    expect(headers['x-device-id']).toBe('device-1')
    expect(headers['x-machine-id']).toBe('machine-1')
    expect(headers['x-uid']).toBe('1234')
  })

  it('unwraps a Result-wrapped status payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ code: 0, Result: { checked_in: true, credits: 50, enable: true } })
      )
    )
    const status = await getCheckinStatus(ACCOUNT, 'tok', SETTINGS)
    expect(status).toEqual({ checkedIn: true, credits: 50, extraCredits: 0, enable: true })
  })

  it('throws TraeWorkCheckinError on a non-zero business code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ code: 9004, message: 'param error' }))
    )
    await expect(getCheckinStatus(ACCOUNT, 'tok', SETTINGS)).rejects.toBeInstanceOf(
      TraeWorkCheckinError
    )
    await expect(getCheckinStatus(ACCOUNT, 'tok', SETTINGS)).rejects.toMatchObject({ code: 9004 })
  })

  it('claimCheckin returns granted credits', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ code: 0, credits: 200 }))
    )
    await expect(claimCheckin(ACCOUNT, 'tok', SETTINGS)).resolves.toBe(200)
  })

  it('getCreditsUsage prefers usage_summary remaining', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          usage_summary: { total_amount: 4950, consumed_amount: 1980.44 },
          user_entitlement_pack_list: [{ entitlement_base_info: { quota: { credits_limit: 100 } } }]
        })
      )
    )
    await expect(getCreditsUsage(ACCOUNT, 'tok', SETTINGS)).resolves.toBe(2970)
  })

  it('getCreditsUsage falls back to summing pack credits_limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          is_credits_billing: true,
          user_entitlement_pack_list: [
            { entitlement_base_info: { quota: { credits_limit: 300 } } },
            { entitlement_base_info: { quota: { credits_limit: 1200 } } }
          ]
        })
      )
    )
    await expect(getCreditsUsage(ACCOUNT, 'tok', SETTINGS)).resolves.toBe(1500)
  })

  it('cnDayKey returns a YYYY-MM-DD key in Asia/Shanghai', () => {
    expect(cnDayKey(Date.parse('2026-09-14T00:30:00+08:00'))).toBe('2026-09-14')
    // 23:30 UTC is already the next day in Shanghai.
    expect(cnDayKey(Date.parse('2026-09-14T15:30:00Z'))).toBe('2026-09-14')
    expect(cnDayKey(Date.parse('2026-09-14T16:30:00Z'))).toBe('2026-09-15')
  })
})

describe('traework/checkinAccounts', () => {
  const state: TraeWorkProviderState = {
    accounts: {},
    currentAccountIndex: 0,
    logs: []
  } as TraeWorkProviderState
  const config: TraeWorkProviderConfig = {
    enabled: true,
    settings: SETTINGS
  } as TraeWorkProviderConfig

  function makePool() {
    const logger = new GatewayLogger({ maxEntries: 10 })
    const pool = new TraeWorkAccountPool(config, state, logger, () => {})
    return pool
  }

  beforeEach(async () => {
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
        if (url.endsWith('/claim')) return jsonResponse({ code: 0, credits: 200 })
        // first status: not checked in; after claim: checked in
        const claimed = calls.filter((u) => u.endsWith('/claim')).length > 0
        return jsonResponse({ checked_in: claimed, credits: 200, enable: true })
      })
    )

    const pool = makePool()
    await pool.reload([{ ...ACCOUNT }])
    const result = await pool.checkinAccounts()

    expect(result.claimed).toBe(1)
    expect(result.failed).toBe(0)
    expect(calls.some((u) => u.endsWith('/claim'))).toBe(true)
    expect(state.accounts['acc-1'].checkin).toMatchObject({
      lastDay: cnDayKey(),
      lastCredits: 200
    })
  })

  it('skips accounts already confirmed for the CN day', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ checked_in: true, credits: 200, enable: true })
    )
    vi.stubGlobal('fetch', fetchMock)

    const pool = makePool()
    await pool.reload([{ ...ACCOUNT }])
    await pool.checkinAccounts()
    const second = await pool.checkinAccounts()

    expect(second.skipped).toBe(1)
    // First run is a single status call (already checked in → no claim, no re-query).
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('force bypasses the day-key skip', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ checked_in: true, credits: 200, enable: true }))
    )
    const pool = makePool()
    await pool.reload([{ ...ACCOUNT }])
    await pool.checkinAccounts()
    const forced = await pool.checkinAccounts('acc-1', true)
    expect(forced.alreadyCheckedIn).toBe(1)
    expect(forced.skipped).toBe(0)
  })

  it('records lastError on failure without marking the day done', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ code: 9074, message: 'busy' }))
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
