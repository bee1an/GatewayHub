import { describe, expect, it } from 'vitest'
import {
  convertOpenAIToGrokPrompt,
  createStreamingState,
  parseGrokGatewayEvent
} from '../streaming'

describe('grokWeb/streaming', () => {
  it('converts OpenAI messages to a single stateless Grok prompt', () => {
    expect(
      convertOpenAIToGrokPrompt([
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: [{ type: 'text', text: 'hello' }] }
      ])
    ).toBe('[system]\nBe terse.\n\nhello')
  })

  it('emits only final answer text deltas and ignores thinking/tool tagged deltas', () => {
    const state = createStreamingState('auto')
    parseGrokGatewayEvent({ type: 'response.created', response: { id: 'resp-1' } }, state)
    expect(
      parseGrokGatewayEvent(
        { type: 'response.output_text.delta', delta: 'hidden', x_grok: { is_thinking: true } },
        state
      ).chunk
    ).toBeNull()
    expect(
      parseGrokGatewayEvent(
        {
          type: 'response.output_text.delta',
          delta: 'tool',
          x_grok: { message_tag: 'tool_usage_card' }
        },
        state
      ).chunk
    ).toBeNull()

    const result = parseGrokGatewayEvent({ type: 'response.output_text.delta', delta: 'OK' }, state)

    expect(state.content).toBe('OK')
    expect(result.chunk).toContain('OK')
    expect(result.chunk).toContain('resp-1')
  })

  it('marks response.done as a stop chunk', () => {
    const state = createStreamingState('auto')
    const result = parseGrokGatewayEvent({ type: 'response.done', response: { id: 'r' } }, state)
    expect(result.done).toBe(true)
    expect(result.chunk).toContain('stop')
  })
})
