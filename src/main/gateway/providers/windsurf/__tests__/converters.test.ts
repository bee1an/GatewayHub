import { describe, expect, it } from 'vitest'
import { anthropicToWindsurfPrompt, openAiToWindsurfPrompt } from '../converters'

describe('windsurf/converters', () => {
  it('builds Cascade prompts from OpenAI messages', () => {
    const result = openAiToWindsurfPrompt({
      messages: [
        { role: 'system', content: 'Be terse.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,YWJj', detail: 'low' }
            }
          ]
        },
        {
          role: 'assistant',
          content: 'Need lookup.',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }
          ]
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'result' }
      ]
    })
    const prompt = result.prompt

    expect(prompt).toContain('System: Be terse.')
    expect(prompt).toContain('User: Hello')
    expect(prompt).toContain('Assistant tool call lookup: {"q":"x"}')
    expect(prompt).toContain('Tool result call_1: result')
    expect(prompt).toContain('1 sent as native Cascade image data')
    expect(result.images).toEqual([{ mimeType: 'image/png', base64Data: 'YWJj', caption: 'low' }])
  })

  it('builds Cascade prompts from Anthropic messages', () => {
    const result = anthropicToWindsurfPrompt({
      system: 'Use tools carefully.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: 'ZGF0YQ==' }
            }
          ]
        },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } }]
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '42' }] }
      ]
    })
    const prompt = result.prompt

    expect(prompt).toContain('System: Use tools carefully.')
    expect(prompt).toContain('User: Hello')
    expect(prompt).toContain('Assistant tool call lookup: {"q":"x"}')
    expect(prompt).toContain('Tool result toolu_1: 42')
    expect(result.images).toEqual([{ mimeType: 'image/jpeg', base64Data: 'ZGF0YQ==' }])
  })
})
