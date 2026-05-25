import { describe, expect, it } from 'vitest'
import { Buffer } from 'buffer'
import {
  buildCodexAccountFromAuth,
  decodeJwtPayload,
  parseCodexAuthInput,
  resolveAccessTokenExpiry,
  resolveChatGptAccountId,
  resolveProfileFromTokens,
  resolveSubscriptionActiveUntil
} from '../normalize'

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.`
}

describe('codex/normalize', () => {
  it('decodes JWT payload base64url-encoded', () => {
    const jwt = makeJwt({ sub: 'user_123', email: 'foo@example.com' })
    const claims = decodeJwtPayload(jwt)
    expect(claims).toMatchObject({ sub: 'user_123', email: 'foo@example.com' })
  })

  it('returns undefined for malformed JWT', () => {
    expect(decodeJwtPayload(undefined)).toBeUndefined()
    expect(decodeJwtPayload('not-a-jwt')).toBeUndefined()
  })

  it('extracts chatgpt account id from id_token claim', () => {
    const id = makeJwt({
      sub: 'sub_x',
      'https://api.openai.com/auth.chatgpt_account_id': 'acct_xyz'
    })
    expect(resolveChatGptAccountId({ id_token: id })).toBe('acct_xyz')
  })

  it('falls back to tokens.account_id when no JWT claim', () => {
    expect(resolveChatGptAccountId({ account_id: 'acct_fallback' })).toBe('acct_fallback')
  })

  it('reads subscription active until from id_token', () => {
    const id = makeJwt({
      'https://api.openai.com/auth.chatgpt_subscription_active_until': '2026-12-31T00:00:00Z'
    })
    expect(resolveSubscriptionActiveUntil({ id_token: id })).toBe('2026-12-31T00:00:00Z')
  })

  it('reads access token exp as epoch ms', () => {
    const access = makeJwt({ exp: 2000000000 })
    expect(resolveAccessTokenExpiry(access)).toBe(2000000000 * 1000)
  })

  it('extracts profile email/name from id_token (namespaced claims)', () => {
    const id = makeJwt({
      sub: 'sub_a',
      'https://api.openai.com/profile.email': 'a@b.com',
      'https://api.openai.com/profile.name': 'Alice'
    })
    expect(resolveProfileFromTokens({ id_token: id })).toMatchObject({
      sub: 'sub_a',
      email: 'a@b.com',
      name: 'Alice'
    })
  })

  it('builds CodexAccountConfig from auth.json payload', () => {
    const id = makeJwt({
      sub: 'sub_test',
      'https://api.openai.com/auth.chatgpt_account_id': 'acct_test',
      'https://api.openai.com/profile.email': 'test@example.com'
    })
    const access = makeJwt({ exp: 2000000000 })
    const account = buildCodexAccountFromAuth({
      auth_mode: 'chatgpt',
      tokens: { access_token: access, refresh_token: 'rt_test', id_token: id }
    })
    expect(account).toMatchObject({
      id: 'codex-sub_test-acct_test',
      enabled: true,
      email: 'test@example.com',
      chatgptAccountId: 'acct_test',
      refreshToken: 'rt_test'
    })
    expect(account?.expiresAt).toBe(2000000000 * 1000)
  })

  it('returns null when payload has no tokens', () => {
    expect(buildCodexAccountFromAuth({ auth_mode: 'chatgpt' })).toBeNull()
  })

  it('parses single-object and array auth.json input', () => {
    const single = JSON.stringify({ tokens: { refresh_token: 'rt1' } })
    expect(parseCodexAuthInput(single)).toHaveLength(1)
    const arr = JSON.stringify([
      { tokens: { refresh_token: 'rt1' } },
      { tokens: { access_token: 'at2' } }
    ])
    expect(parseCodexAuthInput(arr)).toHaveLength(2)
  })

  it('skips entries without any tokens', () => {
    const arr = JSON.stringify([{ tokens: { refresh_token: 'rt' } }, { foo: 'bar' }])
    expect(parseCodexAuthInput(arr)).toHaveLength(1)
  })

  it('parses codexdock export with accounts[].credentials', () => {
    const input = JSON.stringify({
      exported_at: '2026-05-24T11:24:15.622Z',
      proxies: [],
      accounts: [
        {
          name: 'a@b.com',
          platform: 'openai',
          type: 'oauth',
          credentials: {
            access_token: 'at1',
            refresh_token: 'rt1',
            id_token: 'it1',
            chatgpt_account_id: 'acct_dock'
          }
        },
        {
          name: 'c@d.com',
          credentials: { access_token: 'at2' }
        }
      ]
    })
    const payloads = parseCodexAuthInput(input)
    expect(payloads).toHaveLength(2)
    expect(payloads[0].tokens).toMatchObject({
      access_token: 'at1',
      refresh_token: 'rt1',
      id_token: 'it1',
      account_id: 'acct_dock'
    })
    expect(payloads[1].tokens?.access_token).toBe('at2')
  })

  it('parses single codexdock account node', () => {
    const input = JSON.stringify({
      name: 'a@b.com',
      credentials: { refresh_token: 'rt-only' }
    })
    expect(parseCodexAuthInput(input)).toHaveLength(1)
  })

  it('skips codexdock account nodes without usable tokens', () => {
    const input = JSON.stringify({
      accounts: [{ name: 'x', credentials: { plan_type: 'team' } }]
    })
    expect(parseCodexAuthInput(input)).toHaveLength(0)
  })
})
