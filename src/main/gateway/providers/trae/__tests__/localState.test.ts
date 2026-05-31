import { describe, expect, it } from 'vitest'
import { TRAE_LOCAL_STORAGE_KEYS, extractTraeAccountsFromStorage } from '../localState'

describe('trae/localState', () => {
  it('extracts a Trae international account from plain globalStorage JSON', () => {
    const accounts = extractTraeAccountsFromStorage({
      [TRAE_LOCAL_STORAGE_KEYS.auth]: JSON.stringify({
        token: 'Cloud-IDE-JWT jwt-token',
        refreshToken: 'refresh-token',
        expiredAt: 1780000000000,
        refreshExpiredAt: 1790000000000,
        userId: 'user-123',
        aiRegion: 'sg',
        host: 'https://grow-normal.traeapi.us/path',
        account: {
          email: 'USER@EXAMPLE.COM',
          username: 'Trae User'
        }
      })
    })

    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({
      jwtToken: 'jwt-token',
      refreshToken: 'refresh-token',
      tokenExpiresAt: 1780000000000,
      refreshExpiresAt: 1790000000000,
      userId: 'user-123',
      countryCode: 'SG',
      email: 'user@example.com',
      label: 'Trae User',
      authType: 'trae-local-storage',
      authBaseUrl: 'https://grow-normal.traeapi.us',
      sourceType: 'trae_storage'
    })
  })

  it('ignores unrelated or invalid stored values', () => {
    expect(extractTraeAccountsFromStorage({})).toEqual([])
    expect(
      extractTraeAccountsFromStorage({
        [TRAE_LOCAL_STORAGE_KEYS.auth]: '{"not":"credentials"}'
      })
    ).toEqual([])
  })
})
