import { describe, expect, it } from 'vitest'
import { normalizeCookieHeader, normalizeGrokWebImportedAccount } from '../normalize'

describe('grokWeb/normalize', () => {
  it('normalizes raw cookie headers without leaking duplicate cookie names', () => {
    expect(normalizeCookieHeader(' sso=a ; sso-rw=b; sso=a2; x-userid=user ')).toBe(
      'sso=a; sso-rw=b; x-userid=user'
    )
  })

  it('accepts browser-exported cookies and derives a stable user account id', () => {
    const account = normalizeGrokWebImportedAccount({
      cookies: [
        { name: 'sso', value: 'sso-value', domain: '.grok.com' },
        { name: 'sso-rw', value: 'rw-value', domain: '.grok.com' },
        { name: 'x-userid', value: 'user-123', domain: '.grok.com' },
        { name: 'irrelevant', value: 'skip', domain: '.example.com' }
      ],
      user: { email: 'bee@example.com' }
    })

    expect(account).toMatchObject({
      id: expect.stringContaining('grokWeb-user-'),
      email: 'bee@example.com',
      userId: 'user-123',
      enabled: true
    })
    expect(account?.cookieHeader).toContain('sso=sso-value')
    expect(account?.cookieHeader).not.toContain('irrelevant')
  })
})
