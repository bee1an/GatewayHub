import { describe, expect, it } from 'vitest'
import {
  anthropicToTraeMessages,
  buildTraeRawChatPayload,
  openAiToTraeMessages
} from '../converters'

describe('trae/converters', () => {
  it('preserves OpenAI assistant tool calls as textual context for Trae', () => {
    expect(
      openAiToTraeMessages({
        messages: [
          { role: 'user', content: 'write a file' },
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'Write',
                  arguments: '{"file_path":"/tmp/a.txt","content":"ok"}'
                }
              }
            ]
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'done' }
        ]
      })
    ).toEqual([
      { role: 'user', content: 'write a file', tool_call_id: undefined },
      {
        role: 'assistant',
        content: '[tool_call Write] {"file_path":"/tmp/a.txt","content":"ok"}',
        tool_call_id: undefined
      },
      { role: 'tool', content: 'done', tool_call_id: 'call_1' }
    ])
  })

  it('serializes Anthropic tool_use and tool_result history into Trae messages', () => {
    expect(
      anthropicToTraeMessages({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pwd' } }]
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }]
          }
        ]
      })
    ).toEqual([
      { role: 'assistant', content: '[tool_use Bash] {"command":"pwd"}' },
      { role: 'user', content: '[tool_result toolu_1] ok' }
    ])
  })

  it('builds an OpenAI-like raw chat payload with normalized model aliases', () => {
    const payload = buildTraeRawChatPayload(
      'DeepSeek V3',
      {
        max_tokens: 8,
        temperature: 0.2,
        messages: [{ role: 'user', content: 'hi' }]
      },
      'openai'
    )

    expect(payload).toMatchObject({
      model: 'deepseek-v3.2',
      model_name: 'deepseek-v3.2',
      stream: true,
      max_tokens: 8,
      request: {
        model: 'deepseek-v3.2',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true
      }
    })
  })
})
