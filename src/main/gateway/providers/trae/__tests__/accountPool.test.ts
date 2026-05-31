import { describe, expect, it, vi } from 'vitest'
import type { TraeProviderConfig, TraeProviderState } from '../../../types'
import { TraeAccountPool } from '../accountPool'
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
  it('only exposes the verified public free local-bridge model by default', async () => {
    const pool = makePool()
    await pool.reload([{ id: 'trae-jwt-1', enabled: true, jwtToken: 'jwt' }])

    expect(pool.listModels()).toEqual(['gemini_2.5_flash'])
  })

  it('does not add unverified region-gated configs for non-US accounts', async () => {
    const pool = makePool()
    await pool.reload([{ id: 'trae-jwt-1', enabled: true, jwtToken: 'jwt', countryCode: 'SG' }])

    expect(pool.listModels()).toEqual(['gemini_2.5_flash'])
  })

  it('keeps exposeUnavailableInUS from publishing unverified free models', async () => {
    const pool = makePool({ exposeUnavailableInUS: true })
    await pool.reload([{ id: 'trae-jwt-1', enabled: true, jwtToken: 'jwt' }])

    expect(pool.listModels()).toEqual(['gemini_2.5_flash'])
  })

  it('sanitizes stale persisted model lists from remote discovery', async () => {
    const state: TraeProviderState = {
      currentAccountIndex: 0,
      logs: [],
      accounts: {
        'trae-jwt-1': {
          failures: 0,
          lastFailureAt: 0,
          lastSuccessAt: 0,
          modelsCachedAt: 0,
          modelIds: ['deepseek-v3.2', 'gemini-2.5-flash', 'gpt-5.4'],
          status: 'available',
          statusUpdatedAt: 0,
          stats: { totalRequests: 0, successfulRequests: 0, failedRequests: 0 }
        }
      }
    }
    const pool = makePool({}, state)
    await pool.reload([{ id: 'trae-jwt-1', enabled: true, jwtToken: 'jwt' }])

    expect(pool.listModels()).toEqual(['gemini_2.5_flash'])
    expect(state.accounts['trae-jwt-1'].modelIds).toEqual(['gemini_2.5_flash'])
  })
})
