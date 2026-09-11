import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'

const server = setupServer(
  http.get('https://upstream.test/failure', () =>
    HttpResponse.json({ error: 'rate limited' }, { status: 429 })
  ),
  http.get(
    'https://upstream.test/stream',
    () =>
      new HttpResponse('data: {"delta":"ok"}\n\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' }
      })
  )
)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('network boundary fixtures', () => {
  it('models non-2xx and streaming upstream responses without hand-written fetch mocks', async () => {
    const failure = await fetch('https://upstream.test/failure')
    expect(failure.status).toBe(429)
    await expect(failure.json()).resolves.toEqual({ error: 'rate limited' })

    const stream = await fetch('https://upstream.test/stream')
    expect(stream.headers.get('content-type')).toBe('text/event-stream')
    await expect(stream.text()).resolves.toContain('data: [DONE]')
  })
})
