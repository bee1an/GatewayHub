import { describe, expect, it } from 'vitest'
import { buildWindsurfAccountFromInput, parseWindsurfAuthInput } from '../normalize'

describe('windsurf/normalize', () => {
  it('builds an account from apiKey and normalizes email', () => {
    const account = buildWindsurfAccountFromInput({
      apiKey: '  ws-token  ',
      email: 'USER@Example.COM',
      label: 'Local Windsurf',
      apiServerUrl: ' https://server.self-serve.windsurf.com '
    })
    expect(account).toMatchObject({
      id: expect.stringMatching(/^windsurf-/),
      label: 'Local Windsurf',
      email: 'user@example.com',
      enabled: true,
      apiKey: 'ws-token',
      apiServerUrl: 'https://server.self-serve.windsurf.com',
      authType: 'windsurf-api-key'
    })
  })

  it('accepts access_token/token aliases and accounts arrays', () => {
    const accounts = parseWindsurfAuthInput(
      JSON.stringify({
        accounts: [{ access_token: 'at-1', email: 'a@example.com' }, { token: 'tok-2' }]
      })
    )
    expect(accounts).toHaveLength(2)
    expect(accounts[0]).toMatchObject({ apiKey: 'at-1', email: 'a@example.com' })
    expect(accounts[1].apiKey).toBe('tok-2')
  })

  it('skips entries without usable tokens', () => {
    const accounts = parseWindsurfAuthInput(JSON.stringify([{ apiKey: 'ok' }, { foo: 'bar' }]))
    expect(accounts).toHaveLength(1)
    expect(accounts[0].apiKey).toBe('ok')
  })
})
