import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GeminiWebAccountPool, classifyGeminiWebError } from '../accountPool'
import { GEMINI_WEB_KNOWN_MODELS } from '../constants'
import { fetchAccessToken, fetchModels, patchSidts, rotateSidts } from '../http'

vi.mock('../http', () => ({
  fetchAccessToken: vi.fn(),
  fetchModels: vi.fn(),
  rotateSidts: vi.fn(),
  patchSidts: vi.fn((cookie: string, newSidts: string) =>
    cookie.replace(/__Secure-1PSIDTS=[^;]+/g, `__Secure-1PSIDTS=${newSidts}`)
  ),
  clearProxyAgentCache: vi.fn()
}))

function makePool(
  state: any,
  persistAccount?: (accountId: string, updates: any) => Promise<void>
): GeminiWebAccountPool {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any
  return new GeminiWebAccountPool(
    {
      enabled: true,
      routeName: 'geminiWeb',
      settings: {
        baseUrl: 'https://gemini.test',
        vpnProxyUrl: '',
        firstTokenTimeoutSeconds: 30,
        streamingReadTimeoutSeconds: 120,
        maxRetries: 1
      }
    },
    state,
    logger,
    vi.fn(),
    persistAccount
  )
}

describe('geminiWeb/accountPool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('classifies "session tokens not found" as auth', () => {
    expect(
      classifyGeminiWebError(
        new Error('Gemini Web session tokens not found (cookie may be invalid or expired)')
      )
    ).toMatchObject({ kind: 'auth', cooldownMs: 0 })
  })

  it('classifies 403/unusual traffic as rate limit', () => {
    expect(classifyGeminiWebError(new Error('403 unusual traffic'))).toMatchObject({
      kind: 'rate_limit'
    })
  })

  it('classifies 429 as rate limit', () => {
    expect(classifyGeminiWebError(new Error('429 too many requests'))).toMatchObject({
      kind: 'rate_limit'
    })
  })

  it('classifies timeout and network separately', () => {
    expect(classifyGeminiWebError(new Error('Gemini Web first token timed out'))).toMatchObject({
      kind: 'timeout'
    })
    expect(classifyGeminiWebError(new Error('fetch failed: ECONNREFUSED'))).toMatchObject({
      kind: 'network'
    })
  })

  it('classifies quota/capacity as quota', () => {
    expect(classifyGeminiWebError(new Error('quota exceeded'))).toMatchObject({ kind: 'quota' })
  })

  it('falls back to server_error for unknown errors', () => {
    expect(classifyGeminiWebError(new Error('something broke'))).toMatchObject({
      kind: 'server_error'
    })
  })

  it('seeds accounts with the known model fallback list', async () => {
    const state: any = { accounts: {}, currentAccountIndex: 0, logs: [] }
    const pool = makePool(state)
    await pool.reload([{ id: 'acct', enabled: true, cookieHeader: '__Secure-1PSID=a' }])

    expect(pool.listModels()).toEqual(GEMINI_WEB_KNOWN_MODELS)
    expect(state.accounts.acct.modelIds).toEqual(GEMINI_WEB_KNOWN_MODELS)
  })

  it('marks auth_failed when session tokens cannot be scraped', async () => {
    vi.mocked(fetchAccessToken).mockRejectedValue(
      new Error('Gemini Web session tokens not found (cookie may be invalid or expired)')
    )
    const state: any = { accounts: {}, currentAccountIndex: 0, logs: [] }
    const pool = makePool(state)
    await pool.reload([{ id: 'acct', enabled: true, cookieHeader: '__Secure-1PSID=stale' }])

    const result = await pool.testAccount('acct')
    expect(result.ok).toBe(false)
    expect(state.accounts.acct.status).toBe('auth_failed')
  })

  it('keeps fallback models when live model discovery fails after token validation succeeds', async () => {
    vi.mocked(fetchAccessToken).mockResolvedValue({ token: 'SNlM0e-token' })
    vi.mocked(fetchModels).mockRejectedValue(new Error('Gemini Web app error 500'))
    const state: any = { accounts: {}, currentAccountIndex: 0, logs: [] }
    const pool = makePool(state)
    await pool.reload([{ id: 'acct', enabled: true, cookieHeader: '__Secure-1PSID=a' }])

    await expect(pool.testAccount('acct')).resolves.toMatchObject({
      ok: true,
      models: GEMINI_WEB_KNOWN_MODELS
    })
    expect(state.accounts.acct.status).toBe('available')
  })

  it('backfills the signed-in email from the session page', async () => {
    vi.mocked(fetchAccessToken).mockResolvedValue({
      token: 'SNlM0e-token',
      email: 'bee@gmail.com'
    })
    vi.mocked(fetchModels).mockResolvedValue([...GEMINI_WEB_KNOWN_MODELS])
    const state: any = { accounts: {}, currentAccountIndex: 0, logs: [] }
    const pool = makePool(state)
    await pool.reload([{ id: 'acct', enabled: true, cookieHeader: '__Secure-1PSID=a' }])

    await pool.testAccount('acct')
    const [account] = pool.listAccounts()
    expect(account.config.email).toBe('bee@gmail.com')
  })

  it('does not overwrite an existing email', async () => {
    vi.mocked(fetchAccessToken).mockResolvedValue({
      token: 'SNlM0e-token',
      email: 'newbee@gmail.com'
    })
    vi.mocked(fetchModels).mockResolvedValue([...GEMINI_WEB_KNOWN_MODELS])
    const state: any = { accounts: {}, currentAccountIndex: 0, logs: [] }
    const pool = makePool(state)
    await pool.reload([
      { id: 'acct', enabled: true, cookieHeader: '__Secure-1PSID=a', email: 'oldbee@gmail.com' }
    ])

    await pool.testAccount('acct')
    const [account] = pool.listAccounts()
    expect(account.config.email).toBe('oldbee@gmail.com')
  })

  it('redacts the cookie header when listing accounts', async () => {
    const state: any = { accounts: {}, currentAccountIndex: 0, logs: [] }
    const pool = makePool(state)
    await pool.reload([{ id: 'acct', enabled: true, cookieHeader: '__Secure-1PSID=secret' }])

    const [account] = pool.listAccounts()
    expect(account.config.cookieHeader).toBe('***')
  })
})

describe('geminiWeb/accountPool keepalive', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rotates SIDTS on the keepalive tick and persists the new cookieHeader', async () => {
    vi.useFakeTimers()
    vi.mocked(rotateSidts).mockResolvedValue('FRESH_SIDTS')
    const persisted = vi.fn().mockResolvedValue(undefined)
    const state: any = { accounts: {}, currentAccountIndex: 0, logs: [] }
    const pool = makePool(state, persisted)
    await pool.reload([
      { id: 'acct', enabled: true, cookieHeader: '__Secure-1PSID=a; __Secure-1PSIDTS=stale' }
    ])

    // 推进 5 分钟触发一次 keepalive tick
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 100)

    expect(rotateSidts).toHaveBeenCalledTimes(1)
    expect(patchSidts).toHaveBeenCalledWith(
      expect.stringContaining('__Secure-1PSID=a'),
      'FRESH_SIDTS'
    )
    // persistAccount 被以新 cookieHeader 调用,且新值含 FRESH_SIDTS
    expect(persisted).toHaveBeenCalledTimes(1)
    const [, updates] = persisted.mock.calls[0]
    expect(updates.cookieHeader).toContain('__Secure-1PSIDTS=FRESH_SIDTS')

    pool.stopKeepAlive()
    vi.useRealTimers()
  })

  it('does NOT mark auth_failed when rotateSidts returns null (keepalive failure is not account death)', async () => {
    vi.useFakeTimers()
    vi.mocked(rotateSidts).mockResolvedValue(null)
    const persisted = vi.fn().mockResolvedValue(undefined)
    const state: any = { accounts: {}, currentAccountIndex: 0, logs: [] }
    const pool = makePool(state, persisted)
    await pool.reload([
      { id: 'acct', enabled: true, cookieHeader: '__Secure-1PSID=a; __Secure-1PSIDTS=stale' }
    ])

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 100)

    expect(rotateSidts).toHaveBeenCalledTimes(1)
    // 没续上 → 不打 auth_failed,也不回写
    expect(persisted).not.toHaveBeenCalled()
    expect(state.accounts.acct.status).not.toBe('auth_failed')

    pool.stopKeepAlive()
    vi.useRealTimers()
  })

  it('skips auth_failed and disabled accounts on the keepalive tick', async () => {
    vi.useFakeTimers()
    vi.mocked(rotateSidts).mockResolvedValue('FRESH')
    const state: any = { accounts: {}, currentAccountIndex: 0, logs: [] }
    const pool = makePool(state)
    await pool.reload([
      { id: 'dead', enabled: true, cookieHeader: '__Secure-1PSID=dead' },
      { id: 'off', enabled: false, cookieHeader: '__Secure-1PSID=off' },
      { id: 'live', enabled: true, cookieHeader: '__Secure-1PSID=live' }
    ])
    // 把 dead 标成 auth_failed
    state.accounts.dead.status = 'auth_failed'

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 100)

    // 只有 live 被轮换;dead(auth_failed) 和 off(disabled) 跳过
    expect(rotateSidts).toHaveBeenCalledTimes(1)

    pool.stopKeepAlive()
    vi.useRealTimers()
  })

  it('stops the keepalive timer on dispose', async () => {
    vi.useFakeTimers()
    vi.mocked(rotateSidts).mockResolvedValue('FRESH')
    const state: any = { accounts: {}, currentAccountIndex: 0, logs: [] }
    const pool = makePool(state)
    await pool.reload([{ id: 'acct', enabled: true, cookieHeader: '__Secure-1PSID=a' }])

    await pool.dispose()
    const callsBefore = vi.mocked(rotateSidts).mock.calls.length
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 100)
    // dispose 后定时器已清,不应再触发
    expect(vi.mocked(rotateSidts).mock.calls.length).toBe(callsBefore)

    vi.useRealTimers()
  })
})
