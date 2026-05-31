import { describe, expect, it } from 'vitest'
import { anthropicJsonFromText, openAiJsonFromText } from '../streaming'

describe('trae/streaming', () => {
  it('emits OpenAI tool calls in non-streaming responses', () => {
    const response = openAiJsonFromText('', 'deepseek-v3.2', {}, undefined, undefined, [
      { id: 'call_1', name: 'Write', input: { file_path: '/tmp/a.txt', content: 'ok' } }
    ])

    expect(response.choices[0].finish_reason).toBe('tool_calls')
    expect(response.choices[0].message.tool_calls[0]).toMatchObject({
      id: 'call_1',
      type: 'function',
      function: {
        name: 'Write',
        arguments: '{"file_path":"/tmp/a.txt","content":"ok"}'
      }
    })
  })

  it('emits Anthropic tool use blocks in non-streaming responses', () => {
    const response = anthropicJsonFromText('', 'deepseek-v3.2', {}, undefined, undefined, [
      { id: 'toolu_1', name: 'Bash', input: { command: 'pwd' } }
    ])

    expect(response.stop_reason).toBe('tool_use')
    expect(response.content).toEqual([
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pwd' } }
    ])
  })
})
