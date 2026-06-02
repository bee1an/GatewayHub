import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GrokWebAccountPool, classifyGrokWebError } from '../accountPool'
import { GROK_WEB_KNOWN_MODELS } from '../constants'
import { fetchModels, fetchUser } from '../http'

vi.mock('../http', () => ({
  fetchModels: vi.fn(),
  fetchUser: vi.fn()
}))

function makePool(state: any): GrokWebAccountPool {
  return new GrokWebAccountPool(
    {
      enabled: true,
      routeName: 'grokWeb',
      settings: {
        baseUrl: 'https://grok.test',
        wsUrl: 'wss://grok.test/ws/gw/',
        vpnProxyUrl: '',
        firstTokenTimeoutSeconds: 30,
        streamingReadTimeoutSeconds: 180,
        maxRetries: 1
      }
    },
    state,
    {} as any,
    vi.fn()
  )
}

describe('grokWeb/accountPool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('classifies Cloudflare/challenge 403 as rate limit instead of quota', () => {
    expect(
      classifyGrokWebError(new Error('Grok Web user error 403: cloudflare challenge'))
    ).toMatchObject({ kind: 'rate_limit' })
  })

  it('seeds accounts with conservative auto model fallback', async () => {
    const state: any = { accounts: {}, currentAccountIndex: 0, logs: [] }
    const pool = makePool(state)
    await pool.reload([{ id: 'acct', enabled: true, cookieHeader: 'sso=a; x-userid=u' }])

    expect(pool.listModels()).toEqual(GROK_WEB_KNOWN_MODELS)
    expect(state.accounts.acct.modelIds).toEqual(GROK_WEB_KNOWN_MODELS)
  })

  it('keeps fallback models when live model discovery fails after user validation succeeds', async () => {
    vi.mocked(fetchUser).mockResolvedValue({ userId: 'u', email: 'bee@example.com' })
    vi.mocked(fetchModels).mockRejectedValue(new Error('Grok Web models error 403: blocked'))
    const state: any = { accounts: {}, currentAccountIndex: 0, logs: [] }
    const pool = makePool(state)
    await pool.reload([{ id: 'acct', enabled: true, cookieHeader: 'sso=a; x-userid=u' }])

    await expect(pool.testAccount('acct')).resolves.toMatchObject({ ok: true, models: ['auto'] })
    expect(state.accounts.acct.status).toBe('available')
    expect(state.accounts.acct.modelIds).toEqual(['auto'])
  })
})
