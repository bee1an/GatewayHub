import { describe, expect, it } from 'vitest'
import { anthropicToResponsesPayload, chatToResponsesPayload } from '../converters'
import { normalizeCodexModel } from '../constants'

describe('codex/converters', () => {
  it('chatToResponsesPayload: collapses system messages into instructions', () => {
    const payload = chatToResponsesPayload({
      model: 'gpt-5',
      messages: [
        { role: 'system', content: 'You are a strict reviewer.' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
        { role: 'user', content: 'Bye' }
      ]
    })
    expect(payload.instructions).toBe('You are a strict reviewer.')
    expect(payload.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'input_text', text: 'Hi!' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Bye' }] }
    ])
    expect(payload.store).toBe(false)
    expect(payload.stream).toBe(true)
    expect(payload.model).toBe('gpt-5')
  })

  it('chatToResponsesPayload: tool messages converted to function_call_output', () => {
    const payload = chatToResponsesPayload({
      model: 'gpt-5',
      messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'result data' }]
    })
    expect(payload.input[0]).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'result data'
    })
  })

  it('chatToResponsesPayload: forwards tools, tool calls, images, and reasoning effort', () => {
    const payload = chatToResponsesPayload({
      model: 'gpt-5',
      reasoning_effort: 'high',
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
            description: 'Lookup data',
            parameters: { type: 'object', properties: { q: { type: 'string' } } }
          }
        }
      ],
      tool_choice: 'auto',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
          ]
        },
        {
          role: 'assistant',
          content: 'calling',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"q":"x"}' }
            }
          ]
        }
      ]
    })

    expect(payload.input[0].content).toEqual([
      { type: 'input_text', text: 'describe' },
      { type: 'input_image', image_url: 'data:image/png;base64,abc' }
    ])
    expect(payload.input[2]).toEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'lookup',
      arguments: '{"q":"x"}'
    })
    expect(payload.tools[0]).toMatchObject({ type: 'function', name: 'lookup' })
    expect(payload.tool_choice).toBe('auto')
    expect(payload.reasoning).toEqual({ effort: 'high' })
  })

  it('chatToResponsesPayload: provides default instructions when no system', () => {
    const payload = chatToResponsesPayload({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }]
    })
    expect(payload.instructions).toBe('You are a helpful assistant.')
  })

  it('anthropicToResponsesPayload: maps Anthropic messages', () => {
    const payload = anthropicToResponsesPayload({
      model: 'gpt-5',
      system: 'sys text',
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' }
      ],
      temperature: 0.5,
      top_p: 0.9
    })
    expect(payload.instructions).toBe('sys text')
    expect(payload.temperature).toBe(0.5)
    expect(payload.top_p).toBe(0.9)
    expect(payload.input).toHaveLength(2)
  })

  it('anthropicToResponsesPayload: forwards tools, tool_use, tool_result, images, and thinking', () => {
    const payload = anthropicToResponsesPayload({
      model: 'gpt-5',
      thinking: { type: 'enabled', budget_tokens: 1024 },
      tools: [
        {
          name: 'lookup',
          description: 'Lookup data',
          input_schema: { type: 'object', properties: { q: { type: 'string' } } }
        }
      ],
      tool_choice: { type: 'tool', name: 'lookup' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'see image' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }
          ]
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'calling' },
            { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } }
          ]
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'result' }]
        }
      ]
    })

    expect(payload.input[0].content).toEqual([
      { type: 'input_text', text: 'see image' },
      { type: 'input_image', image_url: 'data:image/png;base64,abc' }
    ])
    expect(payload.input[2]).toEqual({
      type: 'function_call',
      call_id: 'toolu_1',
      name: 'lookup',
      arguments: '{"q":"x"}'
    })
    expect(payload.input[3]).toEqual({
      type: 'function_call_output',
      call_id: 'toolu_1',
      output: 'result'
    })
    expect(payload.tools[0]).toMatchObject({ type: 'function', name: 'lookup' })
    expect(payload.tool_choice).toBe('lookup')
    expect(payload.reasoning).toEqual({ effort: 'high' })
  })

  it('normalizeCodexModel: strips date suffix and provider prefix', () => {
    expect(normalizeCodexModel('openai/gpt-5-2025-08-01')).toBe('gpt-5')
    expect(normalizeCodexModel('GPT-5-Codex')).toBe('gpt-5-codex')
    expect(normalizeCodexModel('gpt-5.1-codex')).toBe('gpt-5.1-codex')
  })
})
