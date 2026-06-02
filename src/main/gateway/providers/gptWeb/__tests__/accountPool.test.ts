import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GptWebAccountPool, classifyGptWebError } from '../accountPool'
import { fetchModels } from '../http'
import { GPT_WEB_KNOWN_MODELS } from '../constants'

vi.mock('../http', () => ({
  fetchModels: vi.fn()
}))

describe('gptWeb/accountPool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not classify GptWeb anti-abuse 403 as quota exhaustion', () => {
    expect(
      classifyGptWebError(
        new Error('GptWeb API error 403: Unusual activity has been detected from your device')
      )
    ).toMatchObject({ kind: 'rate_limit' })
  })

  it('classifies fetch failed as a network error', () => {
    expect(classifyGptWebError(new Error('fetch failed'))).toMatchObject({ kind: 'network' })
  })

  it('does not clear cached models during provider reload', async () => {
    const state: any = {
      accounts: {},
      currentAccountIndex: 0,
      logs: []
    }
    const pool = new GptWebAccountPool(
      {
        enabled: true,
        routeName: 'gptWeb',
        settings: {
          baseUrl: 'https://chatgpt.test/backend-api',
          vpnProxyUrl: '',
          firstTokenTimeoutSeconds: 30,
          streamingReadTimeoutSeconds: 120,
          maxRetries: 1
        }
      },
      state,
      {} as any,
      vi.fn()
    )
    const account = {
      id: 'acct',
      enabled: true,
      accessToken: 'access-token',
      accountId: 'chatgpt-account',
      oaiDeviceId: 'device-id'
    }
    await pool.reload([account])
    state.accounts.acct.modelIds = ['cached-model']
    state.accounts.acct.modelsCachedAt = 123

    await pool.reload([account])

    expect(state.accounts.acct.modelIds).toEqual(['cached-model'])
    expect(state.accounts.acct.modelsCachedAt).toBe(123)
  })

  it('shows known usable models in account status before the first live refresh', async () => {
    const state: any = {
      accounts: {},
      currentAccountIndex: 0,
      logs: []
    }
    const pool = new GptWebAccountPool(
      {
        enabled: true,
        routeName: 'gptWeb',
        settings: {
          baseUrl: 'https://chatgpt.test/backend-api',
          vpnProxyUrl: '',
          firstTokenTimeoutSeconds: 30,
          streamingReadTimeoutSeconds: 120,
          maxRetries: 1
        }
      },
      state,
      {} as any,
      vi.fn()
    )
    await pool.reload([
      {
        id: 'acct',
        enabled: true,
        accessToken: 'access-token',
        accountId: 'chatgpt-account',
        oaiDeviceId: 'device-id'
      }
    ])

    expect(pool.listAccounts()[0]?.state.modelIds).toEqual(GPT_WEB_KNOWN_MODELS)
    expect(state.accounts.acct.modelIds).toEqual(GPT_WEB_KNOWN_MODELS)
  })

  it('does not call the live models endpoint during automatic refresh for free fallback models', async () => {
    const state: any = {
      accounts: {},
      currentAccountIndex: 0,
      logs: []
    }
    const pool = new GptWebAccountPool(
      {
        enabled: true,
        routeName: 'gptWeb',
        settings: {
          baseUrl: 'https://chatgpt.test/backend-api',
          vpnProxyUrl: '',
          firstTokenTimeoutSeconds: 30,
          streamingReadTimeoutSeconds: 120,
          maxRetries: 1
        }
      },
      state,
      {} as any,
      vi.fn()
    )
    await pool.reload([
      {
        id: 'acct',
        enabled: true,
        accessToken: 'access-token',
        accountId: 'chatgpt-account',
        oaiDeviceId: 'device-id',
        planType: 'free'
      }
    ])
    state.accounts.acct.modelsCachedAt = 0

    await expect(pool.listModelsFresh()).resolves.toEqual(GPT_WEB_KNOWN_MODELS)

    expect(fetchModels).not.toHaveBeenCalled()
  })

  it('does not replace cached models with an empty list when forced refresh fails', async () => {
    const state: any = {
      accounts: {},
      currentAccountIndex: 0,
      logs: []
    }
    const pool = new GptWebAccountPool(
      {
        enabled: true,
        routeName: 'gptWeb',
        settings: {
          baseUrl: 'https://chatgpt.test/backend-api',
          vpnProxyUrl: '',
          firstTokenTimeoutSeconds: 30,
          streamingReadTimeoutSeconds: 120,
          maxRetries: 1
        }
      },
      state,
      {} as any,
      vi.fn()
    )
    await pool.reload([
      {
        id: 'acct',
        enabled: true,
        accessToken: 'access-token',
        accountId: 'chatgpt-account',
        oaiDeviceId: 'device-id'
      }
    ])
    state.accounts.acct.modelIds = ['cached-model']
    vi.mocked(fetchModels).mockRejectedValue(new Error('GptWeb models error 403: blocked'))

    await expect(pool.refreshAccountModelsById('acct')).resolves.toEqual({
      models: ['cached-model']
    })
    expect(state.accounts.acct.modelIds).toEqual(['cached-model'])
  })

  it('falls back to known usable models when a first forced refresh hits anti-abuse 403', async () => {
    const state: any = {
      accounts: {},
      currentAccountIndex: 0,
      logs: []
    }
    const pool = new GptWebAccountPool(
      {
        enabled: true,
        routeName: 'gptWeb',
        settings: {
          baseUrl: 'https://chatgpt.test/backend-api',
          vpnProxyUrl: '',
          firstTokenTimeoutSeconds: 30,
          streamingReadTimeoutSeconds: 120,
          maxRetries: 1
        }
      },
      state,
      {} as any,
      vi.fn()
    )
    await pool.reload([
      {
        id: 'acct',
        enabled: true,
        accessToken: 'access-token',
        accountId: 'chatgpt-account',
        oaiDeviceId: 'device-id'
      }
    ])
    vi.mocked(fetchModels).mockRejectedValue(new Error('GptWeb models error 403: blocked'))

    await expect(pool.refreshAccountModelsById('acct')).resolves.toEqual({
      models: GPT_WEB_KNOWN_MODELS
    })
    expect(state.accounts.acct.modelIds).toEqual(GPT_WEB_KNOWN_MODELS)
  })

  it('does not mark the account as auth failed when model discovery is Cloudflare-blocked', async () => {
    const state: any = {
      accounts: {},
      currentAccountIndex: 0,
      logs: []
    }
    const pool = new GptWebAccountPool(
      {
        enabled: true,
        routeName: 'gptWeb',
        settings: {
          baseUrl: 'https://chatgpt.test/backend-api',
          vpnProxyUrl: '',
          firstTokenTimeoutSeconds: 30,
          streamingReadTimeoutSeconds: 120,
          maxRetries: 1
        }
      },
      state,
      {} as any,
      vi.fn()
    )
    await pool.reload([
      {
        id: 'acct',
        enabled: true,
        accessToken: 'access-token',
        accountId: 'chatgpt-account',
        oaiDeviceId: 'device-id'
      }
    ])
    vi.mocked(fetchModels).mockRejectedValue(new Error('GptWeb models error 403: Cloudflare'))

    await expect(pool.testAccount('acct')).resolves.toMatchObject({
      ok: true,
      models: GPT_WEB_KNOWN_MODELS
    })
    expect(state.accounts.acct.status).toBe('available')
    expect(state.accounts.acct.modelIds).toEqual(GPT_WEB_KNOWN_MODELS)
  })
})
