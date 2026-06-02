import { describe, expect, it } from 'vitest'
import { createStreamingState, parseGptWebSSE } from '../streaming'

describe('gptWeb/streaming', () => {
  it('parses v1 patch events that omit p and c fields', () => {
    const state = createStreamingState()
    const event = {
      o: 'patch',
      v: [
        { o: 'append', p: '/message/content/parts/0', v: 'OK' },
        { o: 'replace', p: '/message/status', v: 'finished_successfully' }
      ]
    }

    const result = parseGptWebSSE(`data: ${JSON.stringify(event)}`, state)

    expect(state.content).toBe('OK')
    expect(result.chunk).toContain('OK')
    expect(result.chunk).toContain('stop')
    expect(result.done).toBe(false)
  })

  it('captures model metadata from current v1 message envelopes without an add op', () => {
    const state = createStreamingState()

    parseGptWebSSE(
      `data: ${JSON.stringify({
        v: {
          message: {
            id: 'assistant-message',
            metadata: { model_slug: 'gpt-5' }
          }
        }
      })}`,
      state
    )
    const result = parseGptWebSSE(
      `data: ${JSON.stringify({
        o: 'patch',
        v: [{ o: 'append', p: '/message/content/parts/0', v: 'OK' }]
      })}`,
      state
    )

    expect(result.chunk).toContain('"model":"gpt-5"')
    expect(result.chunk).toContain('OK')
  })
})
