import { describe, expect, it } from 'vitest'
import { isAllowedHostHeader, isAllowedOrigin, isLoopbackHost, safeEqualString } from '../http'

describe('gateway/core/http', () => {
  it('compares API keys safely without accepting empty or different-length values', () => {
    expect(safeEqualString('gwh_abc', 'gwh_abc')).toBe(true)
    expect(safeEqualString('gwh_abc', 'gwh_abd')).toBe(false)
    expect(safeEqualString('gwh_abc', 'gwh_abc_extra')).toBe(false)
    expect(safeEqualString('', '')).toBe(false)
  })

  it('allows only loopback Host headers with the expected port', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('0.0.0.0')).toBe(false)

    expect(isAllowedHostHeader('127.0.0.1:9741', 9741)).toBe(true)
    expect(isAllowedHostHeader('localhost', 9741)).toBe(true)
    expect(isAllowedHostHeader('[::1]:9741', 9741)).toBe(true)
    expect(isAllowedHostHeader('evil.example:9741', 9741)).toBe(false)
    expect(isAllowedHostHeader('127.0.0.1:8000', 9741)).toBe(false)
  })

  it('only allows local browser origins for loopback CORS', () => {
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true)
    expect(isAllowedOrigin('http://127.0.0.1:9741')).toBe(true)
    expect(isAllowedOrigin('http://[::1]:9741')).toBe(true)
    expect(isAllowedOrigin('file://local-app')).toBe(true)
    expect(isAllowedOrigin('https://evil.example')).toBe(false)
  })
})
