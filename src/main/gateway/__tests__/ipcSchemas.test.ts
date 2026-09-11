import { describe, expect, it } from 'vitest'
import {
  accountStatusSchema,
  createSettingsPatchSchema,
  portSchema,
  proxyUrlSchema
} from '../ipcSchemas'

describe('IPC schemas', () => {
  it('strips unknown settings and validates known primitive types', () => {
    const schema = createSettingsPatchSchema({ timeout: 30, enabled: false, baseUrl: '' })
    expect(schema.parse({ timeout: 10, unknown: 'ignored' })).toEqual({ timeout: 10 })
    expect(() => schema.parse({ timeout: '10' })).toThrow()
  })

  it('validates common IPC values', () => {
    expect(portSchema.parse(9741)).toBe(9741)
    expect(() => portSchema.parse(70_000)).toThrow()
    expect(accountStatusSchema.parse('available')).toBe('available')
    expect(() => accountStatusSchema.parse('invalid')).toThrow()
  })

  it('accepts supported proxy formats and rejects unsupported protocols', () => {
    expect(proxyUrlSchema.parse('socks5://127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080')
    expect(proxyUrlSchema.parse('127.0.0.1:8080')).toBe('127.0.0.1:8080')
    expect(proxyUrlSchema.parse('')).toBe('')
    expect(() => proxyUrlSchema.parse('socks5h://127.0.0.1:1080')).toThrow()
  })
})
