import { describe, expect, it } from 'vitest'
import { buildTraeAccountFromInput, parseTraeAuthInput } from '../normalize'

const JWT = 'eyJhbGciOiJIUzI1NiJ9.payload.signature'

describe('trae/normalize', () => {
  it('builds an account from refresh token input', () => {
    const account = buildTraeAccountFromInput({
      refreshToken: ' refresh-123 ',
      email: 'USER@EXAMPLE.COM'
    })
    expect(account).toMatchObject({
      enabled: true,
      refreshToken: 'refresh-123',
      email: 'user@example.com',
      authType: 'trae-refresh-token'
    })
    expect(account?.id).toMatch(/^trae-refresh-/)
  })

  it('parses raw JWT text as a jwt-only account', () => {
    const accounts = parseTraeAuthInput(JWT)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({ jwtToken: JWT, authType: 'trae-jwt' })
  })

  it('normalizes Cloud-IDE-JWT prefixes and app storage-shaped fields', () => {
    const account = buildTraeAccountFromInput({
      token: 'Cloud-IDE-JWT app-jwt',
      refreshToken: 'refresh-123',
      authType: 'trae-local-storage',
      expiredAt: 1780000000000,
      refreshExpiredAt: 1790000000000,
      userRegion: { _aiRegion: 'sg' },
      account: {
        email: 'USER@EXAMPLE.COM',
        username: 'Trae User'
      }
    })

    expect(account).toMatchObject({
      jwtToken: 'app-jwt',
      refreshToken: 'refresh-123',
      email: 'user@example.com',
      countryCode: 'SG',
      authType: 'trae-local-storage',
      tokenExpiresAt: 1780000000000,
      refreshExpiresAt: 1790000000000
    })
  })

  it('extracts accounts from exported arrays and de-duplicates by id', () => {
    const accounts = parseTraeAuthInput(
      JSON.stringify({
        accounts: [{ refresh_token: 'r1' }, { refreshToken: 'r1' }, { cloudIdeJwt: 'j2' }]
      })
    )
    expect(accounts.map((a) => a.authType)).toEqual(['trae-refresh-token', 'trae-jwt'])
  })
})
