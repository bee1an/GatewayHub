import { describe, expect, it } from 'vitest'
import { parseOpenRouterAuthInput } from '../normalize'

describe('openrouter/normalize', () => {
  it('builds an account from a raw sk-or key', () => {
    const [account] = parseOpenRouterAuthInput('sk-or-v1-abc123')
    expect(account).toMatchObject({
      id: expect.stringMatching(/^openrouter-/),
      label: expect.stringMatching(/^OpenRouter /),
      enabled: true,
      apiKey: 'sk-or-v1-abc123'
    })
  })

  it('parses JSON objects and arrays with apiKey/key aliases', () => {
    expect(
      parseOpenRouterAuthInput(
        JSON.stringify({
          accounts: [
            { key: 'sk-or-v1-one', name: 'one' },
            { apiKey: 'sk-or-v1-two', label: 'two', enabled: false }
          ]
        })
      )
    ).toMatchObject([
      { apiKey: 'sk-or-v1-one', label: 'one', enabled: true },
      { apiKey: 'sk-or-v1-two', label: 'two', enabled: false }
    ])
  })
})
