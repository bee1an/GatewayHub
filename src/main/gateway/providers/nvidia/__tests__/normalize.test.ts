import { describe, expect, it } from 'vitest'
import { parseNvidiaAuthInput } from '../normalize'

describe('nvidia/normalize', () => {
  it('builds an account from a raw API key', () => {
    const [account] = parseNvidiaAuthInput('nvapi-abc123')
    expect(account).toMatchObject({
      id: expect.stringMatching(/^nvidia-/),
      label: expect.stringMatching(/^NVIDIA /),
      enabled: true,
      apiKey: 'nvapi-abc123'
    })
  })

  it('parses JSON objects and arrays with apiKey/key aliases', () => {
    expect(
      parseNvidiaAuthInput(
        JSON.stringify({
          accounts: [
            { key: 'nvapi-one', name: 'one' },
            { apiKey: 'nvapi-two', label: 'two', enabled: false }
          ]
        })
      )
    ).toMatchObject([
      { apiKey: 'nvapi-one', label: 'one', enabled: true },
      { apiKey: 'nvapi-two', label: 'two', enabled: false }
    ])
  })
})
