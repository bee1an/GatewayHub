import { describe, expect, it } from 'vitest'
import {
  getCookieValue,
  normalizeCookieHeader,
  normalizeGeminiWebImportedAccount
} from '../normalize'

describe('geminiWeb/normalize', () => {
  it('parses a cookieHeader string into an account', () => {
    const account = normalizeGeminiWebImportedAccount({
      cookieHeader: '__Secure-1PSID=abc; SID=def',
      email: 'bee@example.com'
    })
    expect(account).toBeDefined()
    expect(account!.id).toMatch(/^geminiWeb-cookie-/)
    expect(account!.cookieHeader).toBe('__Secure-1PSID=abc; SID=def')
    expect(account!.email).toBe('bee@example.com')
    expect(account!.enabled).toBe(true)
  })

  it('returns undefined when __Secure-1PSID is missing', () => {
    expect(normalizeGeminiWebImportedAccount({ cookieHeader: 'SID=def; NID=xyz' })).toBeUndefined()
    expect(normalizeGeminiWebImportedAccount({})).toBeUndefined()
    expect(normalizeGeminiWebImportedAccount(null)).toBeUndefined()
  })

  it('builds a cookie header from a browser-exported cookies[] array', () => {
    const account = normalizeGeminiWebImportedAccount({
      cookies: [
        { name: '__Secure-1PSID', value: 'abc', domain: '.google.com' },
        { name: 'SID', value: 'def', domain: '.google.com' },
        { name: 'irrelevant', value: 'keep', domain: '.google.com' }
      ]
    })
    expect(account).toBeDefined()
    // A full browser cookie export is kept verbatim (Gemini validates the whole
    // jar), including non-session cookies.
    expect(account!.cookieHeader).toBe('__Secure-1PSID=abc; SID=def; irrelevant=keep')
  })

  it('accepts a bare __Secure-1PSID named field', () => {
    const account = normalizeGeminiWebImportedAccount({ __Secure_1PSID: 'abc' })
    expect(account).toBeDefined()
    expect(getCookieValue(account!.cookieHeader, '__Secure-1PSID')).toBe('abc')
  })

  it('dedupes repeated cookie names case-insensitively', () => {
    expect(normalizeCookieHeader('__Secure-1PSID=a; __secure-1psid=b; SID=c')).toBe(
      '__Secure-1PSID=a; SID=c'
    )
  })

  it('preserves an explicit id when provided', () => {
    const account = normalizeGeminiWebImportedAccount({
      id: 'custom-id',
      cookieHeader: '__Secure-1PSID=abc'
    })
    expect(account!.id).toBe('custom-id')
  })

  it('derives a stable id from the cookie header', () => {
    const a = normalizeGeminiWebImportedAccount({ cookieHeader: '__Secure-1PSID=abc' })
    const b = normalizeGeminiWebImportedAccount({ cookieHeader: '__Secure-1PSID=abc' })
    expect(a!.id).toBe(b!.id)
    const c = normalizeGeminiWebImportedAccount({ cookieHeader: '__Secure-1PSID=xyz' })
    expect(c!.id).not.toBe(a!.id)
  })
})
