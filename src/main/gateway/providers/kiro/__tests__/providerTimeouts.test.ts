import { describe, expect, it, vi } from 'vitest'
import type { KiroProviderConfig, KiroProviderState } from '../../../types'
import { DEFAULT_KIRO_SETTINGS } from '../constants'
import { KiroProvider } from '../provider'

function makeDelayedKiroStream(delayMs: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{"content":"hello "}'))
      setTimeout(() => {
        controller.enqueue(encoder.encode('{"content":"world"}'))
        controller.close()
      }, delayMs)
    }
  })
}

function makeProvider(): KiroProvider {
  const config: KiroProviderConfig = {
    enabled: true,
    settings: {
      ...DEFAULT_KIRO_SETTINGS,
      firstTokenTimeoutSeconds: 0.01,
      streamingReadTimeoutSeconds: 0.05,
      maxRetries: 1
    }
  }
  const state: KiroProviderState = { accounts: {}, currentAccountIndex: 0, logs: [] }
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
  const provider = new KiroProvider(config, state, logger as any, vi.fn())
  const patchedProvider = provider as any
  const account = {
    config: {
      id: 'acc-1',
      email: 'a@example.com',
      enabled: true
    },
    state: {
      failures: 0,
      lastFailureAt: 0,
      lastSuccessAt: 0,
      modelsCachedAt: Date.now(),
      modelIds: ['claude-opus-4.6'],
      status: 'available',
      statusUpdatedAt: 0,
      stats: {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0
      }
    }
  }
  patchedProvider.pool = {
    listAccounts: vi.fn(() => [account]),
    getAccountForModel: vi.fn(async () => account),
    reportSuccess: vi.fn(),
    reportFailure: vi.fn()
  }
  patchedProvider.callKiro = vi.fn(async () => ({
    ok: true,
    body: makeDelayedKiroStream(30)
  }))
  return provider
}

describe('KiroProvider timeouts', () => {
  it('uses streamingReadTimeoutSeconds as post-first-token idle timeout', async () => {
    const provider = makeProvider()
    const response = await provider.messages(
      {
        model: 'claude-opus-4.6',
        max_tokens: 32,
        stream: false,
        messages: [{ role: 'user', content: 'hi' }]
      },
      { requestId: 'req_test', apiFormat: 'anthropic' }
    )

    expect(response.status).toBe(200)
    expect((response.body as any).content[0].text).toBe('hello world')
    expect((provider as any).pool.reportSuccess).toHaveBeenCalledTimes(1)
  })
})
