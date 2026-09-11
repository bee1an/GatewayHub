import { describe, expect, it } from 'vitest'
import {
  anthropicToTraeWorkMessages,
  buildTraeWorkChatPayload,
  buildTraeWorkTools,
  openAiToTraeWorkMessages
} from '../converters'
import { DEFAULT_TRAEWORK_SETTINGS } from '../constants'

describe('traework/converters', () => {
  it('converts OpenAI messages to text-part content arrays', () => {
    const out = openAiToTraeWorkMessages({
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' }
      ]
    })
    expect(out).toEqual([
      { role: 'system', content: [{ type: 'text', text: 'be terse' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }
    ])
  })

  it('maps OpenAI tool_calls to function_call entries and tool results to role:tool', () => {
    const out = openAiToTraeWorkMessages({
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"BJ"}' }
            }
          ]
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'sunny' }
      ]
    })
    expect(out[1].tool_calls?.[0]).toMatchObject({
      type: 'function',
      function_call: { name: 'get_weather', arguments: '{"city":"BJ"}' }
    })
    expect(out[2]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: [{ type: 'text', text: 'sunny' }]
    })
  })

  it('converts Anthropic system + tool_use + tool_result', () => {
    const out = anthropicToTraeWorkMessages({
      system: 'be nice',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'run it' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'running' },
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pwd' } }
          ]
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '/tmp' }]
        }
      ]
    })
    expect(out[0]).toEqual({ role: 'system', content: [{ type: 'text', text: 'be nice' }] })
    expect(out[2].tool_calls?.[0]?.function_call).toEqual({
      name: 'Bash',
      arguments: '{"command":"pwd"}'
    })
    expect(out[3]).toEqual({
      role: 'tool',
      tool_call_id: 'toolu_1',
      content: [{ type: 'text', text: '/tmp' }]
    })
  })

  it('stringifies tool parameter schemas', () => {
    const tools = buildTraeWorkTools(
      {
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'weather',
              parameters: { type: 'object', properties: { city: { type: 'string' } } }
            }
          }
        ]
      },
      'openai'
    )
    expect(tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'weather',
          parameters: '{"type":"object","properties":{"city":{"type":"string"}}}'
        }
      }
    ])
    const anthropicTools = buildTraeWorkTools(
      { tools: [{ name: 'Bash', description: 'shell', input_schema: { type: 'object' } }] },
      'anthropic'
    )
    expect(anthropicTools?.[0]?.function?.parameters).toBe('{"type":"object"}')
  })

  it('builds the llm_utils_chat payload with config_name + model', () => {
    const payload = buildTraeWorkChatPayload(
      'glm-5.3',
      { messages: [{ role: 'user', content: 'hi' }], max_tokens: 64 },
      'openai',
      DEFAULT_TRAEWORK_SETTINGS
    )
    expect(payload).toMatchObject({
      function: 'chat_v3',
      stream: true,
      config_name: 'glm-5.3',
      model: 'glm-5.3',
      max_tokens: 64
    })
    expect(payload.messages[0].content).toEqual([{ type: 'text', text: 'hi' }])
  })
})
