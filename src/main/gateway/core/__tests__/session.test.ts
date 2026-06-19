import { describe, expect, it } from 'vitest'
import { deriveGatewaySession } from '../session'
import type { ApiKeyEntry } from '../../types'

const apiKey: ApiKeyEntry = {
  id: 'key-test',
  key: 'ghub-test',
  name: 'Test',
  createdAt: 0
}

describe('gateway session derivation', () => {
  it('prefers explicit client session identifiers over generated fallbacks', () => {
    const fromMetadata = deriveGatewaySession(
      { 'x-claude-session-id': 'header-session' },
      {
        model: 'qoder/qwen3.7-max',
        metadata: { session_id: 'metadata-session' },
        messages: [{ role: 'user', content: 'hello' }]
      },
      apiKey,
      'req-a',
      'openai'
    )
    const fromHeader = deriveGatewaySession(
      { 'x-claude-session-id': 'header-session' },
      {
        model: 'qoder/qwen3.7-max',
        messages: [{ role: 'user', content: 'hello' }]
      },
      apiKey,
      'req-b',
      'openai'
    )

    expect(fromMetadata).toEqual({ id: 'metadata-session', source: 'metadata' })
    expect(fromHeader).toEqual({ id: 'header-session', source: 'header' })
  })

  it('keeps fallback ids stable across request ids and later conversation turns', () => {
    const firstTurn = deriveGatewaySession(
      {},
      {
        model: 'qoder/qwen3.7-max',
        system: 'You are a coding assistant.',
        messages: [{ role: 'user', content: 'fix the failing test' }]
      },
      apiKey,
      'req-first',
      'anthropic'
    )
    const laterTurn = deriveGatewaySession(
      {},
      {
        model: 'qoder/qwen3.7-max',
        system: 'You are a coding assistant.',
        messages: [
          { role: 'user', content: 'fix the failing test' },
          { role: 'assistant', content: 'I will inspect it.' },
          { role: 'user', content: 'continue' }
        ]
      },
      apiKey,
      'req-later',
      'anthropic'
    )

    expect(firstTurn.source).toBe('fallback')
    expect(laterTurn.source).toBe('fallback')
    expect(firstTurn.id).toBe(laterTurn.id)
    expect(firstTurn.id).toMatch(/^[a-f0-9]{32}$/)
  })
})
