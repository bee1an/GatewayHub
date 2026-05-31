import { describe, expect, it } from 'vitest'
import type {
  AccountRuntimeState,
  WindsurfAccountConfig,
  WindsurfProviderConfig,
  WindsurfProviderState
} from '../../../types'
import { GatewayLogger } from '../../../core/logger'
import { DEFAULT_WINDSURF_SETTINGS } from '../constants'
import { WindsurfAccountPool } from '../accountPool'

describe('windsurf/accountPool', () => {
  it('invalidates persisted model cache on reload', async () => {
    const account: WindsurfAccountConfig = {
      id: 'windsurf-test',
      label: 'Windsurf Test',
      enabled: true,
      apiKey: 'test-token'
    }
    const state: WindsurfProviderState = {
      accounts: {
        [account.id]: {
          ...defaultRuntimeState(),
          modelsCachedAt: Date.now(),
          modelIds: ['MODEL_CHAT_GPT_5_CODEX', 'swe-1-6-slow']
        }
      },
      currentAccountIndex: 0,
      logs: []
    }
    const pool = new WindsurfAccountPool(
      {
        enabled: true,
        routeName: 'windsurf',
        settings: DEFAULT_WINDSURF_SETTINGS
      } as WindsurfProviderConfig,
      state,
      new GatewayLogger({ maxEntries: 100 }),
      () => {
        /* noop */
      }
    )

    await pool.reload([account])

    expect(state.accounts[account.id].modelsCachedAt).toBe(0)
    expect(state.accounts[account.id].modelIds).toEqual([])

    await pool.dispose()
  })
})

function defaultRuntimeState(): AccountRuntimeState {
  return {
    failures: 0,
    lastFailureAt: 0,
    lastSuccessAt: 0,
    modelsCachedAt: 0,
    modelIds: [],
    status: 'available',
    statusUpdatedAt: 0,
    stats: {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0
    }
  }
}
