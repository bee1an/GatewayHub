import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpenRouterProviderConfig, OpenRouterProviderState } from '../../../types'
import { OpenRouterAccountPool, filterModelsForKey } from '../accountPool'
import { DEFAULT_OPENROUTER_SETTINGS, OPENROUTER_FREE_ROUTER_MODEL } from '../constants'
import { scoreAccountForRace } from '../../requestRace'

function makePool(
  state: OpenRouterProviderState = { accounts: {}, currentAccountIndex: 0, logs: [] },
  persistAccount = vi.fn()
): OpenRouterAccountPool {
  const config: OpenRouterProviderConfig = {
    enabled: true,
    routeName: 'openrouter',
    settings: { ...DEFAULT_OPENROUTER_SETTINGS }
  }
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
  return new OpenRouterAccountPool(config, state, logger as any, vi.fn(), persistAccount)
}

describe('openrouter/accountPool', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('filters public models by key tier', () => {
    const models = [
      { id: 'deepseek/deepseek-chat-v3-0324:free' },
      { id: 'anthropic/claude-3.5-sonnet' }
    ]

    expect(filterModelsForKey(models, { is_free_tier: true })).toEqual([
      'deepseek/deepseek-chat-v3-0324:free',
      OPENROUTER_FREE_ROUTER_MODEL
    ])
    expect(filterModelsForKey(models, { is_free_tier: false })).toEqual([
      'anthropic/claude-3.5-sonnet',
      'deepseek/deepseek-chat-v3-0324:free'
    ])
  })

  it('validates the key via /key before publishing tier-filtered models', async () => {
    const persist = vi.fn().mockResolvedValue(undefined)
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/key')) {
        return Response.json({
          data: { label: 'free-key', is_free_tier: true, limit_remaining: 1.5, usage: 0.2 }
        })
      }
      if (url.endsWith('/models')) {
        return Response.json({
          data: [
            { id: 'deepseek/deepseek-chat-v3-0324:free' },
            { id: 'anthropic/claude-3.5-sonnet' }
          ]
        })
      }
      return Response.json({ error: 'unexpected url' }, { status: 500 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const state: OpenRouterProviderState = { accounts: {}, currentAccountIndex: 0, logs: [] }
    const pool = makePool(state, persist)
    await pool.reload([{ id: 'or-1', enabled: true, apiKey: 'sk-or-v1-test' }])

    const result = await pool.testAccount('or-1')

    expect(result.ok).toBe(true)
    expect(state.accounts['or-1'].modelIds).toEqual([
      'deepseek/deepseek-chat-v3-0324:free',
      OPENROUTER_FREE_ROUTER_MODEL
    ])
    expect(pool.listAccounts()[0].config).toMatchObject({
      apiKey: '***',
      keyLabel: 'free-key',
      isFreeTier: true,
      limitRemaining: 1.5
    })
    expect(persist).toHaveBeenCalledWith(
      'or-1',
      expect.objectContaining({ keyLabel: 'free-key', isFreeTier: true, limitRemaining: 1.5 })
    )
  })

  it('routes requests only to accounts that can serve the requested model', async () => {
    const now = Date.now()
    const state: OpenRouterProviderState = {
      currentAccountIndex: 0,
      logs: [],
      accounts: {
        free: {
          failures: 0,
          lastFailureAt: 0,
          lastSuccessAt: 0,
          modelsCachedAt: now,
          modelIds: ['deepseek/deepseek-chat-v3-0324:free'],
          status: 'available',
          statusUpdatedAt: now,
          stats: { totalRequests: 0, successfulRequests: 0, failedRequests: 0 }
        },
        paid: {
          failures: 0,
          lastFailureAt: 0,
          lastSuccessAt: 0,
          modelsCachedAt: now,
          modelIds: ['anthropic/claude-3.5-sonnet'],
          status: 'available',
          statusUpdatedAt: now,
          stats: { totalRequests: 0, successfulRequests: 0, failedRequests: 0 }
        }
      }
    }
    const pool = makePool(state)
    await pool.reload([
      { id: 'free', enabled: true, apiKey: 'sk-or-v1-free' },
      { id: 'paid', enabled: true, apiKey: 'sk-or-v1-paid' }
    ])

    await expect(pool.getAccountForModel('anthropic/claude-3.5-sonnet')).resolves.toMatchObject({
      config: { id: 'paid' }
    })
    await expect(
      pool.getAccountForModel('deepseek/deepseek-chat-v3-0324:free')
    ).resolves.toMatchObject({
      config: { id: 'free' }
    })
  })

  it('selects one round-robin race slot and fills remaining slots by score', async () => {
    const now = Date.now()
    const state: OpenRouterProviderState = {
      currentAccountIndex: 2,
      logs: [],
      accounts: {
        a: runtimeState(now, ['model-a'], { successes: 1, attempts: 1, successRateEwma: 0.8 }),
        b: runtimeState(now, ['model-a'], {
          successes: 10,
          attempts: 10,
          successRateEwma: 1,
          ewmaLatencyMs: 100
        }),
        c: runtimeState(now, ['model-a'], {
          failures: 4,
          attempts: 4,
          successRateEwma: 0.1,
          ewmaLatencyMs: 20_000
        })
      }
    }
    const pool = makePool(state)
    await pool.reload([
      { id: 'a', enabled: true, apiKey: 'sk-or-v1-a' },
      { id: 'b', enabled: true, apiKey: 'sk-or-v1-b' },
      { id: 'c', enabled: true, apiKey: 'sk-or-v1-c' }
    ])

    const selected = await pool.getRaceAccountsForModel('model-a', 2)

    expect(selected.map((account) => account.config.id)).toEqual(['c', 'b'])
    expect(state.currentAccountIndex).toBe(0)
  })

  it('skips disabled, hard-offline, and model-incompatible keys for request racing', async () => {
    const now = Date.now()
    const state: OpenRouterProviderState = {
      currentAccountIndex: 0,
      logs: [],
      accounts: {
        disabled: runtimeState(now, ['model-a']),
        auth: { ...runtimeState(now, ['model-a']), status: 'auth_failed' },
        quota: { ...runtimeState(now, ['model-a']), status: 'quota_exceeded' },
        other: runtimeState(now, ['other-model']),
        ok: runtimeState(now, ['model-a'])
      }
    }
    const pool = makePool(state)
    await pool.reload([
      { id: 'disabled', enabled: false, apiKey: 'sk-or-v1-disabled' },
      { id: 'auth', enabled: true, apiKey: 'sk-or-v1-auth' },
      { id: 'quota', enabled: true, apiKey: 'sk-or-v1-quota' },
      { id: 'other', enabled: true, apiKey: 'sk-or-v1-other' },
      { id: 'ok', enabled: true, apiKey: 'sk-or-v1-ok' }
    ])

    const selected = await pool.getRaceAccountsForModel('model-a', 6)

    expect(selected.map((account) => account.config.id)).toEqual(['ok'])
  })

  it('updates race score on success and failure while leaving aborted losers untouched', async () => {
    const now = Date.now()
    const state: OpenRouterProviderState = {
      currentAccountIndex: 0,
      logs: [],
      accounts: { key: runtimeState(now, ['model-a']) }
    }
    const pool = makePool(state)
    await pool.reload([{ id: 'key', enabled: true, apiKey: 'sk-or-v1-key' }])
    const account = (await pool.getAccountForModel('model-a'))!

    await pool.reportSuccess(account, 120)
    const scoreAfterSuccess = scoreAccountForRace(account.state)
    expect(account.state.raceStats).toMatchObject({ attempts: 1, successes: 1, failures: 0 })

    const statsBeforeAbort = { ...account.state.raceStats }
    // Aborted race losers are intentionally not reported to the pool.
    expect(account.state.raceStats).toEqual(statsBeforeAbort)

    await pool.reportFailure(account, new Error('timeout'), { kind: 'timeout', cooldownMs: 0 })
    expect(account.state.raceStats).toMatchObject({ attempts: 2, successes: 1, failures: 1 })
    expect(scoreAccountForRace(account.state)).toBeLessThan(scoreAfterSuccess)
  })
})

function runtimeState(
  now: number,
  modelIds: string[],
  raceStats?: Partial<NonNullable<OpenRouterProviderState['accounts'][string]['raceStats']>>
): OpenRouterProviderState['accounts'][string] {
  return {
    failures: 0,
    lastFailureAt: 0,
    lastSuccessAt: 0,
    modelsCachedAt: now,
    modelIds,
    status: 'available',
    statusUpdatedAt: now,
    stats: { totalRequests: 0, successfulRequests: 0, failedRequests: 0 },
    raceStats: raceStats
      ? {
          attempts: raceStats.attempts ?? 0,
          successes: raceStats.successes ?? 0,
          failures: raceStats.failures ?? 0,
          ewmaLatencyMs: raceStats.ewmaLatencyMs,
          successRateEwma: raceStats.successRateEwma
        }
      : undefined
  }
}
