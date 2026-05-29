import { describe, expect, it } from 'vitest'
import { anthropicJsonFromText, openAiJsonFromText, openAiSseFromText } from '../streaming'

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

  it('emits OpenAI SSE chunks and done marker', async () => {
    const chunks: string[] = []
    for await (const chunk of openAiSseFromText('HI', 'swe-1-6-slow', {})) chunks.push(chunk)

    expect(chunks.join('')).toContain('"content":"HI"')
    expect(chunks.at(-1)).toBe('data: [DONE]\n\n')
  })
})
