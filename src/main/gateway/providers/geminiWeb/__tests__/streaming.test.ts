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

  it('treats successive text events as cumulative — only emits the new suffix', () => {
    // Gemini StreamGenerate emits the running full text on every frame, not
    // incremental deltas. parseGeminiBatchEvent must compute the prefix-delta
    // so OpenAI clients see proper increments and the final reassembled text
    // is the last frame's content (no duplication).
    const state = createStreamingState()
    const r1 = parseGeminiBatchEvent({ type: 'text', delta: '我是' }, state)
    expect(r1.chunk).toContain('我是')
    const r2 = parseGeminiBatchEvent({ type: 'text', delta: '我是 Gemini' }, state)
    expect(r2.chunk).toContain(' Gemini')
    expect(r2.chunk).not.toContain('我是 Gemini')
    expect(state.content).toBe('我是 Gemini')
  })

  it('emits the whole replacement when an upstream frame rewrites earlier text', () => {
    // Rare but possible: a candidate's text node changes mid-stream rather
    // than only being extended. We still want a non-empty chunk in that case
    // (degrade gracefully).
    const state = createStreamingState()
    parseGeminiBatchEvent({ type: 'text', delta: '我是 A' }, state)
    const r = parseGeminiBatchEvent({ type: 'text', delta: 'completely new' }, state)
    expect(r.chunk).toContain('completely new')
    expect(state.content).toBe('completely new')
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
