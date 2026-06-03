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

describe('openrouter/provider request race', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('supports Anthropic /messages by converting through OpenAI chat completions', async () => {
    const state = stateWithAccounts(['a'])
    const provider = makeProvider(state, { requestRaceEnabled: false })
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

  it('keeps serial retry behavior when request race is disabled', async () => {
    const state = stateWithAccounts(['a', 'b'])
    const provider = makeProvider(state, { requestRaceEnabled: false, maxRetries: 1 })
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

  it('uses the fastest complete successful JSON response and aborts pending losers', async () => {
    const state = stateWithAccounts(['slow', 'fast', 'rate'])
    state.accounts.fast.raceStats = {
      attempts: 3,
      successes: 3,
      failures: 0,
      successRateEwma: 1,
      ewmaLatencyMs: 20
    }
    state.accounts.rate.raceStats = { attempts: 3, successes: 1, failures: 2, successRateEwma: 0.2 }
    const provider = makeProvider(state, {
      requestRaceEnabled: true,
      requestRaceMaxConcurrent: 3,
      maxRetries: 5
    })
    await provider.initialize([
      { id: 'slow', enabled: true, apiKey: 'sk-or-v1-slow' },
      { id: 'fast', enabled: true, apiKey: 'sk-or-v1-fast' },
      { id: 'rate', enabled: true, apiKey: 'sk-or-v1-rate' }
    ])
    let slowAborted = false
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = String((init?.headers as any)?.Authorization || '')
      if (auth.endsWith('sk-or-v1-rate')) {
        await delay(5)
        return Response.json({ error: 'rate limited' }, { status: 429 })
      }
      if (auth.endsWith('sk-or-v1-fast')) {
        await delay(25)
        return Response.json({
          id: 'fast-winner',
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 2 }
        })
      }
      init?.signal?.addEventListener('abort', () => {
        slowAborted = true
      })
      await abortableDelay(500, init?.signal ?? undefined)
      return Response.json({ id: 'slow-loser', choices: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await provider.chatCompletions(
      { model: 'model-a', messages: [{ role: 'user', content: 'hi' }] },
      { requestId: 'req-race', apiFormat: 'openai' }
    )

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ id: 'fast-winner' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(slowAborted).toBe(true)
    expect(state.accounts.fast.stats.successfulRequests).toBe(1)
    expect(state.accounts.rate.stats.failedRequests).toBe(1)
    expect(state.accounts.slow.stats.failedRequests).toBe(0)
    expect(state.accounts.slow.raceStats).toBeUndefined()
  })

  it('uses the first streaming body chunk as winner without dropping or duplicating it', async () => {
    const state = stateWithAccounts(['slow', 'fast'])
    state.accounts.fast.raceStats = {
      attempts: 1,
      successes: 1,
      failures: 0,
      successRateEwma: 1,
      ewmaLatencyMs: 10
    }
    const provider = makeProvider(state, { requestRaceEnabled: true, requestRaceMaxConcurrent: 2 })
    await provider.initialize([
      { id: 'slow', enabled: true, apiKey: 'sk-or-v1-slow' },
      { id: 'fast', enabled: true, apiKey: 'sk-or-v1-fast' }
    ])
    let slowAborted = false
    const encoder = new TextEncoder()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const auth = String((init?.headers as any)?.Authorization || '')
        if (auth.endsWith('sk-or-v1-fast')) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                setTimeout(() => controller.enqueue(encoder.encode('data: {"delta":"A"}\n\n')), 5)
                setTimeout(() => {
                  controller.enqueue(encoder.encode('data: {"delta":"B"}\n\n'))
                  controller.close()
                }, 15)
              }
            }),
            { status: 200 }
          )
        }
        init?.signal?.addEventListener('abort', () => {
          slowAborted = true
        })
        return new Response(new ReadableStream<Uint8Array>({}), { status: 200 })
      })
    )

    const response = await provider.chatCompletions(
      { model: 'model-a', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { requestId: 'req-stream', apiFormat: 'openai' }
    )
    const chunks = await collectStream(response.stream!)

    expect(chunks.join('')).toBe('data: {"delta":"A"}\n\ndata: {"delta":"B"}\n\n')
    expect(slowAborted).toBe(true)
    expect(state.accounts.fast.stats.successfulRequests).toBe(1)
    expect(state.accounts.slow.stats.failedRequests).toBe(0)
  })

  it('aborts the winning upstream stream when the client disconnects', async () => {
    const state = stateWithAccounts(['slow', 'fast'])
    state.accounts.fast.raceStats = {
      attempts: 1,
      successes: 1,
      failures: 0,
      successRateEwma: 1,
      ewmaLatencyMs: 10
    }
    const provider = makeProvider(state, { requestRaceEnabled: true, requestRaceMaxConcurrent: 2 })
    await provider.initialize([
      { id: 'slow', enabled: true, apiKey: 'sk-or-v1-slow' },
      { id: 'fast', enabled: true, apiKey: 'sk-or-v1-fast' }
    ])
    let fastAborted = false
    const encoder = new TextEncoder()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const auth = String((init?.headers as any)?.Authorization || '')
        if (auth.endsWith('sk-or-v1-fast')) {
          init?.signal?.addEventListener('abort', () => {
            fastAborted = true
          })
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                setTimeout(() => controller.enqueue(encoder.encode('data: first\n\n')), 5)
              }
            }),
            { status: 200 }
          )
        }
        return new Response(new ReadableStream<Uint8Array>({}), { status: 200 })
      })
    )
    const clientAbort = new AbortController()
    const response = await provider.chatCompletions(
      { model: 'model-a', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { requestId: 'req-client-abort', apiFormat: 'openai', abortSignal: clientAbort.signal }
    )
    const iterator = response.stream![Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({ value: 'data: first\n\n' })
    clientAbort.abort(new Error('client closed'))
    await iterator.return?.(undefined)

    expect(fastAborted).toBe(true)
    expect(state.accounts.fast.stats.successfulRequests).toBe(0)
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      },
      { once: true }
    )
  })
}

async function collectStream(stream: AsyncIterable<string | Uint8Array>): Promise<string[]> {
  const chunks: string[] = []
  for await (const chunk of stream)
    chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
  return chunks
}
