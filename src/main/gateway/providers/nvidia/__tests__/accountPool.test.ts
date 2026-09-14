import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NvidiaProviderConfig, NvidiaProviderState } from '../../../types'
import { NvidiaAccountPool, filterModelsForKey } from '../accountPool'
import { DEFAULT_NVIDIA_SETTINGS } from '../constants'

function makePool(
  state: NvidiaProviderState = { accounts: {}, currentAccountIndex: 0, logs: [] },
  persistAccount = vi.fn()
): NvidiaAccountPool {
  const config: NvidiaProviderConfig = {
    enabled: true,
    routeName: 'nvidia',
    settings: { ...DEFAULT_NVIDIA_SETTINGS, firstTokenTimeoutSeconds: 1 }
  }
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
  return new NvidiaAccountPool(config, state, logger as any, vi.fn(), persistAccount)
}

describe('nvidia/accountPool', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('filters non-chat catalog entries from the public model list', () => {
    const models = [
      { id: 'meta/llama-3.1-8b-instruct' },
      { id: 'nvidia/embed-qa-4' },
      { id: 'baai/bge-m3' },
      { id: 'black-forest-labs/flux.1-schnell' },
      { id: 'openai/gpt-oss-20b' }
    ]

    expect(filterModelsForKey(models)).toEqual(['meta/llama-3.1-8b-instruct', 'openai/gpt-oss-20b'])
  })

  it('validates the key with a tiny chat request before publishing models', async () => {
    const persist = vi.fn().mockResolvedValue(undefined)
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/chat/completions')) {
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer nvapi-test' })
        return Response.json({ choices: [{ message: { content: 'OK' } }] })
      }
      if (url.endsWith('/models')) {
        return Response.json({
          data: [{ id: 'meta/llama-3.1-8b-instruct' }, { id: 'nvidia/embed-qa-4' }]
        })
      }
      return Response.json({ error: 'unexpected url' }, { status: 500 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const state: NvidiaProviderState = { accounts: {}, currentAccountIndex: 0, logs: [] }
    const pool = makePool(state, persist)
    await pool.reload([{ id: 'nv-1', enabled: true, apiKey: 'nvapi-test' }])

    const result = await pool.testAccount('nv-1')

    expect(result.ok).toBe(true)
    expect(state.accounts['nv-1'].modelIds).toEqual(['meta/llama-3.1-8b-instruct'])
    expect(pool.listAccounts()[0].config).toMatchObject({
      apiKey: '***',
      keyLabel: 'NVIDIA NIM'
    })
    expect(persist).toHaveBeenCalledWith(
      'nv-1',
      expect.objectContaining({ keyLabel: 'NVIDIA NIM' })
    )
  })

  it('routes requests only to accounts that can serve the requested model', async () => {
    const now = Date.now()
    const state: NvidiaProviderState = {
      currentAccountIndex: 0,
      logs: [],
      accounts: {
        nano: {
          failures: 0,
          lastFailureAt: 0,
          lastSuccessAt: 0,
          modelsCachedAt: now,
          modelIds: ['nvidia/llama-3.1-nemotron-nano-8b-v1'],
          status: 'available',
          statusUpdatedAt: now,
          stats: { totalRequests: 0, successfulRequests: 0, failedRequests: 0 }
        },
        meta: {
          failures: 0,
          lastFailureAt: 0,
          lastSuccessAt: 0,
          modelsCachedAt: now,
          modelIds: ['meta/llama-3.1-8b-instruct'],
          status: 'available',
          statusUpdatedAt: now,
          stats: { totalRequests: 0, successfulRequests: 0, failedRequests: 0 }
        }
      }
    }
    const pool = makePool(state)
    await pool.reload([
      { id: 'nano', enabled: true, apiKey: 'nvapi-nano' },
      { id: 'meta', enabled: true, apiKey: 'nvapi-meta' }
    ])

    await expect(pool.getAccountForModel('meta/llama-3.1-8b-instruct')).resolves.toMatchObject({
      config: { id: 'meta' }
    })
    await expect(
      pool.getAccountForModel('nvidia/llama-3.1-nemotron-nano-8b-v1')
    ).resolves.toMatchObject({
      config: { id: 'nano' }
    })
  })
})
