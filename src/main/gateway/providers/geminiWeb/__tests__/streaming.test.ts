import { describe, expect, it } from 'vitest'
import {
  convertOpenAIToGeminiPrompt,
  createStreamingState,
  parseGeminiBatchEvent
} from '../streaming'

describe('geminiWeb/streaming', () => {
  it('converts OpenAI messages to a single flattened Gemini prompt', () => {
    expect(
      convertOpenAIToGeminiPrompt([
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: [{ type: 'text', text: 'hello' }] }
      ])
    ).toBe('[system]\nBe terse.\n\nhello')
  })

  it('defaults an empty message list to a non-empty prompt', () => {
    expect(convertOpenAIToGeminiPrompt([])).toBe('Hello')
  })

  it('emits OpenAI content chunks for text deltas', () => {
    const state = createStreamingState('gemini-3.1-pro')
    const result = parseGeminiBatchEvent({ type: 'text', delta: 'Hi there' }, state)
    expect(state.content).toBe('Hi there')
    expect(result.chunk).toContain('Hi there')
    expect(result.chunk).toContain('gemini-3.1-pro')
    expect(result.chunk).toContain('chat.completion.chunk')
    expect(result.done).toBe(false)
  })

  it('ignores empty text deltas', () => {
    const state = createStreamingState('gemini-3.1-pro')
    const result = parseGeminiBatchEvent({ type: 'text', delta: '' }, state)
    expect(result.chunk).toBeNull()
    expect(result.done).toBe(false)
  })

  it('marks a done event as a stop chunk', () => {
    const state = createStreamingState('gemini-3.1-pro')
    const result = parseGeminiBatchEvent({ type: 'done' }, state)
    expect(result.done).toBe(true)
    expect(result.chunk).toContain('stop')
    expect(state.finished).toBe(true)
  })

  it('throws on an error event', () => {
    const state = createStreamingState('gemini-3.1-pro')
    expect(() =>
      parseGeminiBatchEvent({ type: 'error', message: 'Gemini Web failed' }, state)
    ).toThrow('Gemini Web failed')
  })
})
