import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../auth', () => ({
  kiroFetch: vi.fn()
}))

import { kiroFetch } from '../auth'
import {
  normalizeImportedAccount,
  normalizeKiroExpiresAt,
  resolveRefreshTokenAccount
} from '../normalize'

describe('kiro/normalize', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-02T03:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('normalizes numeric expiresAt values from account-manager exports', () => {
    expect(normalizeKiroExpiresAt(1780371164506)).toBe('2026-06-02T03:32:44.506Z')
    expect(normalizeKiroExpiresAt('1780371164506')).toBe('2026-06-02T03:32:44.506Z')
    expect(normalizeKiroExpiresAt('1780371164')).toBe('2026-06-02T03:32:44.000Z')

    expect(
      normalizeImportedAccount({
        accessToken: 'access-token',
        expiresAt: 1780371164506
      })?.expiresAt
    ).toBe('2026-06-02T03:32:44.506Z')
  })

  it('uses AWS SSO OIDC refresh when client credentials are present', async () => {
    vi.mocked(kiroFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          expiresIn: 1200
        }),
        { status: 200 }
      )
    )

    const account = await resolveRefreshTokenAccount({
      refreshToken: 'refresh-token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      region: 'us-west-2'
    })

    expect(kiroFetch).toHaveBeenCalledTimes(1)
    const [url, init] = vi.mocked(kiroFetch).mock.calls[0]
    expect(url).toBe('https://oidc.us-west-2.amazonaws.com/token')
    expect(JSON.parse(String(init.body))).toEqual({
      grantType: 'refresh_token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token'
    })
    expect(account).toMatchObject({
      refreshToken: 'new-refresh',
      accessToken: 'new-access',
      expiresAt: '2026-06-02T03:19:00.000Z'
    })
  })

  it('keeps using Kiro Desktop refresh when client credentials are absent', async () => {
    vi.mocked(kiroFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          accessToken: 'desktop-access',
          refreshToken: 'desktop-refresh',
          profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/example',
          expiresIn: 3600
        }),
        { status: 200 }
      )
    )

    await resolveRefreshTokenAccount({
      refreshToken: 'refresh-token',
      region: 'us-east-1'
    })

    expect(vi.mocked(kiroFetch).mock.calls[0][0]).toBe(
      'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken'
    )
  })
})
