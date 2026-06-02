import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchConduitToken, fetchModels, fetchSentinelTokens } from '../http'
import type { GptWebRequestContext } from '../http'

function buildCtx(): GptWebRequestContext {
  return {
    account: {
      id: 'acct',
      enabled: true,
      accessToken: 'access-token',
      accountId: 'gptWeb-account',
      oaiDeviceId: 'device-id'
    },
    settings: {
      baseUrl: 'https://chatgpt.test/backend-api',
      vpnProxyUrl: '',
      firstTokenTimeoutSeconds: 30,
      streamingReadTimeoutSeconds: 120,
      maxRetries: 1
    }
  }
}

describe('gptWeb/http', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('sends the conversation body to /f/conversation/prepare', async () => {
    const body = { action: 'next', messages: [{ id: 'm1' }] }
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual(body)
      return Response.json({ status: 'ok', conduit_token: 'conduit-token' })
    })
    vi.stubGlobal('fetch', fetchMock)

    const ctx = buildCtx()

    await expect(
      fetchConduitToken(ctx, body, {
        chatRequirementsToken: 'chat-requirements-token',
        proofToken: 'proof-token'
      })
    ).resolves.toBe('conduit-token')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://chatgpt.test/backend-api/f/conversation/prepare',
      expect.objectContaining({
        body: JSON.stringify(body),
        headers: expect.objectContaining({
          'chatgpt-account-id': 'gptWeb-account',
          'openai-sentinel-chat-requirements-token': 'chat-requirements-token',
          'openai-sentinel-proof-token': 'proof-token'
        })
      })
    )
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['gptWeb-account-id']).toBeUndefined()
  })

  it('surfaces conduit prepare errors instead of silently dropping the token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ detail: 'Invalid conversation body' }, { status: 422 }))
    )

    const ctx = buildCtx()

    await expect(fetchConduitToken(ctx, { action: 'next' })).rejects.toThrow(
      'GptWeb conduit prepare error 422'
    )
  })

  it('uses the upstream chatgpt-account-id header when fetching models', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      expect(headers['chatgpt-account-id']).toBe('gptWeb-account')
      expect(headers['gptWeb-account-id']).toBeUndefined()
      return Response.json({ models: [{ slug: 'gpt-5' }] })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchModels(buildCtx())).resolves.toEqual(['gpt-5', 'auto'])
  })

  it('throws model fetch errors instead of returning an empty model list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('blocked', { status: 403 }))
    )

    await expect(fetchModels(buildCtx())).rejects.toThrow('GptWeb models error 403')
  })

  it('uses browserless requirements and official proofofwork finalize key', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init })
        if (url.endsWith('/sentinel/chat-requirements/prepare')) {
          return Response.json({
            persona: 'gptWeb-freeaccount',
            prepare_token: 'prepare-token',
            turnstile: { required: true, dx: 'dx' },
            proofofwork: { required: true, seed: 'seed', difficulty: '0' }
          })
        }
        if (url.endsWith('/sentinel/chat-requirements/finalize')) {
          return Response.json({
            persona: 'gptWeb-freeaccount',
            token: 'chat-req-token',
            expire_after: 1000,
            expire_at: Date.now() + 1000
          })
        }
        return Response.json({}, { status: 404 })
      })
    )

    await expect(fetchSentinelTokens(buildCtx())).resolves.toMatchObject({
      chatRequirementsToken: 'chat-req-token'
    })

    const prepareBody = JSON.parse(String(calls[0].init?.body))
    expect(prepareBody.p).toEqual(expect.stringMatching(/^gAAAAAC/))
    expect((calls[0].init?.headers as Record<string, string>).cookie).toBeUndefined()

    const finalizeBody = JSON.parse(String(calls[1].init?.body))
    expect(finalizeBody.prepare_token).toBe('prepare-token')
    expect(finalizeBody.proofofwork).toEqual(expect.stringMatching(/^gAAAAAB/))
    expect(finalizeBody.proof_token).toBeUndefined()
    expect(finalizeBody.turnstile).toBeUndefined()
    expect((calls[1].init?.headers as Record<string, string>).cookie).toBeUndefined()
  })
})
