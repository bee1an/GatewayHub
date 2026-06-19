import { describe, expect, it, vi } from 'vitest'
import type { TraeProviderConfig, TraeProviderState } from '../../../types'
import { TraeAccountPool, sanitizeUsableModelIds } from '../accountPool'
import { DEFAULT_TRAE_SETTINGS } from '../constants'

function makePool(
  settings: Partial<typeof DEFAULT_TRAE_SETTINGS> = {},
  state: TraeProviderState = { accounts: {}, currentAccountIndex: 0, logs: [] }
): TraeAccountPool {
  const config: TraeProviderConfig = {
    enabled: true,
    settings: { ...DEFAULT_TRAE_SETTINGS, ...settings }
  }
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
  return new TraeAccountPool(config, state, logger as any, vi.fn())
}

describe('trae/accountPool', () => {
  it('falls back to the built-in model when no upstream list is cached', async () => {
    const pool = makePool()
    await pool.reload([{ id: 'trae-jwt-1', enabled: true, jwtToken: 'jwt' }])

    expect(pool.listModels()).toEqual(['gemini_2.5_flash'])
  })

  it('uses the built-in fallback for non-US accounts without a cached list', async () => {
    const pool = makePool()
    await pool.reload([{ id: 'trae-jwt-1', enabled: true, jwtToken: 'jwt', countryCode: 'SG' }])

    expect(pool.listModels()).toEqual(['gemini_2.5_flash'])
  })

  it('keeps exposeUnavailableInUS inert while the upstream list is uncached', async () => {
    const pool = makePool({ exposeUnavailableInUS: true })
    await pool.reload([{ id: 'trae-jwt-1', enabled: true, jwtToken: 'jwt' }])

    expect(pool.listModels()).toEqual(['gemini_2.5_flash'])
  })

  it('discards persisted model caches on reload so stale whitelists do not survive', async () => {
    const state: TraeProviderState = {
      currentAccountIndex: 0,
      logs: [],
      accounts: {
        'trae-jwt-1': {
          failures: 0,
          lastFailureAt: 0,
          lastSuccessAt: 0,
          modelsCachedAt: Date.now(),
          modelIds: ['deepseek-v3.2', 'gemini-2.5-flash', 'gpt-5.4'],
          status: 'available',
          statusUpdatedAt: 0,
          stats: { totalRequests: 0, successfulRequests: 0, failedRequests: 0 }
        }
      }
    }
    const pool = makePool({}, state)
    await pool.reload([{ id: 'trae-jwt-1', enabled: true, jwtToken: 'jwt' }])

    // reload clears the persisted list + cache timestamp; listModels falls back
    // to the built-in model until the next upstream refresh repopulates it.
    expect(state.accounts['trae-jwt-1'].modelIds).toEqual([])
    expect(state.accounts['trae-jwt-1'].modelsCachedAt).toBe(0)
    expect(pool.listModels()).toEqual(['gemini_2.5_flash'])
  })
})

describe('trae/sanitizeUsableModelIds', () => {
  it('passes through all normalized upstream configs without whitelisting', () => {
    expect(
      sanitizeUsableModelIds(['deepseek-v3.2', 'Gemini-2.5-Flash', 'gpt-5.4', 'grok-4', ''])
    ).toEqual(['deepseek-v3.2', 'gemini_2.5_flash', 'gpt-5.4', 'grok-4'])
  })

  it('deduplicates ids that normalize to the same canonical name', () => {
    expect(
      sanitizeUsableModelIds(['gemini-2.5-flash', 'gemini25flash', 'gemini_2.5_flash'])
    ).toEqual(['gemini_2.5_flash'])
  })
})
