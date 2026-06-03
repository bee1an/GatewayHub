import { describe, expect, it } from 'vitest'
import {
  anthropicJsonFromText,
  anthropicSseFromCascadeDeltas,
  openAiJsonFromText,
  openAiSseFromCascadeDeltas,
  openAiSseFromText
} from '../streaming'

describe('windsurf/streaming', () => {
  it('returns OpenAI-compatible non-streaming text responses', () => {
    const result = openAiJsonFromText(
      'OK',
      'swe-1-6-slow',
      { messages: [{ role: 'user', content: 'hello' }] },
      undefined,
      { inputTokens: 10, outputTokens: 1, estimated: false }
    )

    expect(result.object).toBe('chat.completion')
    expect(result.choices[0]).toMatchObject({
      message: { role: 'assistant', content: 'OK' },
      finish_reason: 'stop'
    })
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 })
  })

  it('returns Anthropic-compatible non-streaming text responses', () => {
    const result = anthropicJsonFromText('YES', 'swe-1-6-slow', {}, undefined, {
      inputTokens: 7,
      outputTokens: 1,
      estimated: false
    })

    expect(result).toMatchObject({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'YES' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 7, output_tokens: 1 }
    })
  })

  it('maps inline tool_call blocks to OpenAI and Anthropic tool outputs', () => {
    const text =
      'Use tool\n<tool_call>{"id":"call_1","name":"Bash","arguments":{"command":"pwd"}}</tool_call>'
    const openai = openAiJsonFromText(text, 'swe-1-6-slow', {})
    expect(openai.choices[0].finish_reason).toBe('tool_calls')
    expect(openai.choices[0].message.content).toBe('Use tool')
    expect(openai.choices[0].message.tool_calls[0]).toMatchObject({
      id: 'call_1',
      function: { name: 'Bash', arguments: '{"command":"pwd"}' }
    })

    const anthropic = anthropicJsonFromText(text, 'swe-1-6-slow', {})
    expect(anthropic.stop_reason).toBe('tool_use')
    expect(anthropic.content).toContainEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'Bash',
      input: { command: 'pwd' }
    })
  })

  it('preserves cache usage details in OpenAI usage', () => {
    const result = openAiJsonFromText('OK', 'swe-1-6-slow', {}, undefined, {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWrite5mTokens: 4
    })
    expect(result.usage).toEqual({
      prompt_tokens: 17,
      completion_tokens: 2,
      total_tokens: 19,
      prompt_tokens_details: { cached_tokens: 3 }
    })
  })

  it('emits OpenAI SSE chunks and done marker', async () => {
    const chunks: string[] = []
    for await (const chunk of openAiSseFromText('HI', 'swe-1-6-slow', {})) chunks.push(chunk)

    expect(chunks.join('')).toContain('"content":"HI"')
    expect(chunks.at(-1)).toBe('data: [DONE]\n\n')
  })

  it('emits OpenAI SSE deltas and tool call deltas from Cascade polling events', async () => {
    async function* source() {
      yield {
        cascadeId: 'c1',
        text: 'Hel',
        textDelta: 'Hel',
        usage: { inputTokens: 10, outputTokens: 1 }
      }
      yield {
        cascadeId: 'c1',
        text: 'Hello',
        textDelta: 'lo',
        usage: { inputTokens: 10, outputTokens: 2 },
        toolCalls: [{ id: 'call_1', name: 'lookup', input: { q: 'x' } }],
        done: true
      }
    }
    const chunks: string[] = []
    for await (const chunk of openAiSseFromCascadeDeltas(source(), 'swe-1-6-slow', {})) {
      chunks.push(chunk)
    }

    const joined = chunks.join('')
    expect(joined).toContain('"content":"Hel"')
    expect(joined).toContain('"content":"lo"')
    expect(joined).toContain('"tool_calls"')
    expect(joined).toContain('"finish_reason":"tool_calls"')
    expect(chunks.at(-1)).toBe('data: [DONE]\n\n')
  })

  it('emits Anthropic SSE text and tool_use deltas from Cascade polling events', async () => {
    async function* source() {
      yield {
        cascadeId: 'c1',
        text: 'Hello',
        textDelta: 'Hello',
        usage: { inputTokens: 10, outputTokens: 2 },
        toolCalls: [{ id: 'toolu_1', name: 'lookup', input: { q: 'x' } }],
        done: true
      }
    }
    const chunks: string[] = []
    for await (const chunk of anthropicSseFromCascadeDeltas(source(), 'swe-1-6-slow', {})) {
      chunks.push(chunk)
    }

    const joined = chunks.join('')
    expect(joined).toContain('event: message_start')
    expect(joined).toContain('"type":"text_delta","text":"Hello"')
    expect(joined).toContain('"type":"tool_use","id":"toolu_1","name":"lookup"')
    expect(joined).toContain('"partial_json":"{\\"q\\":\\"x\\"}"')
    expect(joined).toContain('"stop_reason":"tool_use"')
  })
})
