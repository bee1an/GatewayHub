import { describe, expect, it } from 'vitest'
import { anthropicToWindsurfPrompt, openAiToWindsurfPrompt } from '../converters'

describe('windsurf/converters', () => {
  it('builds Cascade prompts from OpenAI messages', () => {
    const prompt = openAiToWindsurfPrompt({
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'Hello' },
        {
          role: 'assistant',
          content: 'Need lookup.',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }
          ]
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'result' }
      ]
    }).prompt

    expect(prompt).toContain('System: Be terse.')
    expect(prompt).toContain('User: Hello')
    expect(prompt).toContain('Assistant tool call lookup: {"q":"x"}')
    expect(prompt).toContain('Tool result call_1: result')
  })

  it('builds Cascade prompts from Anthropic messages', () => {
    const prompt = anthropicToWindsurfPrompt({
      system: 'Use tools carefully.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } }]
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '42' }] }
      ]
    }).prompt

    expect(prompt).toContain('System: Use tools carefully.')
    expect(prompt).toContain('User: Hello')
    expect(prompt).toContain('Assistant tool call lookup: {"q":"x"}')
    expect(prompt).toContain('Tool result toolu_1: 42')
  })
})
