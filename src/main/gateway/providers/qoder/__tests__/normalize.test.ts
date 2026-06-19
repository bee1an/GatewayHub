import { describe, expect, it } from 'vitest'
import { normalizeQoderModel } from '../constants'
import { parseQoderAuthInput } from '../normalize'

describe('qoder/normalize', () => {
  it('parses raw PAT and JSON account exports', () => {
    const raw = parseQoderAuthInput('qoder-pat-123')
    expect(raw[0]).toMatchObject({
      id: expect.stringMatching(/^qoder-/),
      label: expect.stringMatching(/^Qoder /),
      enabled: true,
      personalAccessToken: 'qoder-pat-123'
    })

    const json = parseQoderAuthInput(
      JSON.stringify({
        accounts: [
          {
            pat: 'pat-json',
            label: 'Work Qoder',
            email: 'USER@EXAMPLE.COM',
            qoderCliPath: '/tmp/qodercli'
          }
        ]
      })
    )
    expect(json[0]).toMatchObject({
      label: 'Work Qoder',
      email: 'user@example.com',
      authType: 'qoder-personal-access-token',
      personalAccessToken: 'pat-json',
      qoderCliPath: '/tmp/qodercli'
    })

    const cli = parseQoderAuthInput(
      JSON.stringify({
        authType: 'qoder-cli-auth',
        label: 'Local Qoder CLI',
        qoderCliHome: '/tmp/qoder-home'
      })
    )
    expect(cli[0]).toMatchObject({
      id: expect.stringMatching(/^qoder-cli-/),
      label: 'Local Qoder CLI',
      enabled: true,
      authType: 'qoder-cli-auth',
      qoderCliHome: '/tmp/qoder-home'
    })
    expect(cli[0].personalAccessToken).toBeUndefined()
  })

  it('maps common client model names to qoder tiers and passes custom IDs through', () => {
    expect(normalizeQoderModel('gpt-4o')).toBe('auto')
    expect(normalizeQoderModel('claude-3-opus')).toBe('ultimate')
    expect(normalizeQoderModel('claude-3-haiku')).toBe('efficient')
    expect(normalizeQoderModel('deepseek-v4-flash')).toBe('dfmodel')
    expect(normalizeQoderModel('qwen3.7-max')).toBe('qmodel_latest')
    expect(normalizeQoderModel('Qwen3.7-Max')).toBe('qmodel_latest')
    expect(normalizeQoderModel('qwen-3.7-max')).toBe('qmodel_latest')
    expect(normalizeQoderModel('my-custom-model')).toBe('my-custom-model')
  })
})
