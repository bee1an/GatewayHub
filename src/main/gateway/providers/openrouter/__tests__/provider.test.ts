import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AccountRuntimeState,
  OpenRouterProviderConfig,
  OpenRouterProviderState
} from '../../../types'
import { OpenRouterProvider } from '../provider'
import { DEFAULT_OPENROUTER_SETTINGS } from '../constants'

function makeProvider(
  state: OpenRouterProviderState,
  settings: Partial<OpenRouterProviderConfig['settings']> = {}
): OpenRouterProvider {
  const config: OpenRouterProviderConfig = {
    enabled: true,
    routeName: 'openrouter',
    settings: { ...DEFAULT_OPENROUTER_SETTINGS, firstTokenTimeoutSeconds: 1, ...settings }
  }
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return new OpenRouterProvider(config, state, logger as any, vi.fn())
}

function stateWithAccounts(ids: string[], model = 'model-a'): OpenRouterProviderState {
  const now = Date.now()
  return {
    currentAccountIndex: 0,
    logs: [],
    accounts: Object.fromEntries(ids.map((id) => [id, runtimeState(now, [model])]))
  }
}

describe('openrouter/provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('supports Anthropic /messages by converting through OpenAI chat completions', async () => {
    const state = stateWithAccounts(['a'])
    const provider = makeProvider(state)
    await provider.initialize([{ id: 'a', enabled: true, apiKey: 'sk-or-v1-a' }])
    let upstreamBody: any
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        upstreamBody = JSON.parse(String(init?.body))
        return Response.json({
          id: 'chatcmpl-openrouter',
          model: 'model-a',
          choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1 }
        })
      })
    )

    const response = await provider.messages(
      {
        model: 'model-a',
        max_tokens: 8,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
      },
      { requestId: 'req-anthropic', apiFormat: 'anthropic' }
    )

    expect(response.status).toBe(200)
    expect(upstreamBody).toMatchObject({
      model: 'model-a',
      max_tokens: 8,
      stream: false,
      messages: [{ role: 'user', content: 'hi' }]
    })
    expect(response.body).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: 'model-a',
      content: [{ type: 'text', text: 'OK' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 1 }
    })
  })

  it('retries the next account serially on upstream failure', async () => {
    const state = stateWithAccounts(['a', 'b'])
    const provider = makeProvider(state, { maxRetries: 1 })
    await provider.initialize([
      { id: 'a', enabled: true, apiKey: 'sk-or-v1-a' },
      { id: 'b', enabled: true, apiKey: 'sk-or-v1-b' }
    ])
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = String((init?.headers as any)?.Authorization || '')
      if (auth.endsWith('sk-or-v1-a')) return Response.json({ error: 'temporary' }, { status: 500 })
      return Response.json({ id: 'serial-success', choices: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await provider.chatCompletions(
      { model: 'model-a', messages: [{ role: 'user', content: 'hi' }] },
      { requestId: 'req-serial', apiFormat: 'openai' }
    )

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ id: 'serial-success' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

function runtimeState(now: number, modelIds: string[]): AccountRuntimeState {
  return {
    failures: 0,
    lastFailureAt: 0,
    lastSuccessAt: 0,
    modelsCachedAt: now,
    modelIds,
    status: 'available',
    statusUpdatedAt: now,
    stats: { totalRequests: 0, successfulRequests: 0, failedRequests: 0 }
  }
}
