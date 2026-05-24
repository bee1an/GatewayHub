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

  it('chatToResponsesPayload: tool messages encoded into user input', () => {
    const payload = chatToResponsesPayload({
      model: 'gpt-5',
      messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'result data' }]
    })
    expect(payload.input[0]).toMatchObject({
      role: 'user'
    })
    expect(payload.input[0].content[0].text).toContain('tool_result')
    expect(payload.input[0].content[0].text).toContain('result data')
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

  it('normalizeCodexModel: strips date suffix and provider prefix', () => {
    expect(normalizeCodexModel('openai/gpt-5-2025-08-01')).toBe('gpt-5')
    expect(normalizeCodexModel('GPT-5-Codex')).toBe('gpt-5-codex')
    expect(normalizeCodexModel('gpt-5.1-codex')).toBe('gpt-5.1-codex')
  })
})
