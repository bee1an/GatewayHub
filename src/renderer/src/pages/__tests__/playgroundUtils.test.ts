import { describe, expect, it } from 'vitest'
import {
  type ChatMessage,
  makeId,
  sliceBeforeMessage,
  prepareHistory,
  flattenMessages
} from '../playgroundUtils'

describe('playgroundUtils', () => {
  describe('makeId', () => {
    it('generates a non-empty string', () => {
      const id = makeId()
      expect(id).toBeTruthy()
      expect(typeof id).toBe('string')
    })

    it('generates unique IDs on successive calls', () => {
      const ids = new Set(Array.from({ length: 100 }, () => makeId()))
      expect(ids.size).toBe(100)
    })
  })

  describe('sliceBeforeMessage', () => {
    const messages: ChatMessage[] = [
      { id: 'm1', role: 'user', content: 'hi' },
      { id: 'm2', role: 'assistant', content: 'hello' },
      { id: 'm3', role: 'user', content: 'how are you' },
      { id: 'm4', role: 'assistant', content: '', error: 'fail' }
    ]

    it('drops the target message and everything after it', () => {
      const result = sliceBeforeMessage(messages, 'm4')
      expect(result).toHaveLength(3)
      expect(result[0].id).toBe('m1')
      expect(result[2].id).toBe('m3')
    })

    it('returns all messages before a middle one', () => {
      const result = sliceBeforeMessage(messages, 'm3')
      expect(result).toHaveLength(2)
      expect(result.map((m) => m.id)).toEqual(['m1', 'm2'])
    })

    it('returns all messages when target is the first', () => {
      const result = sliceBeforeMessage(messages, 'm1')
      expect(result).toHaveLength(0)
    })

    it('returns the full array when target is not found', () => {
      const result = sliceBeforeMessage(messages, 'nonexistent')
      expect(result).toHaveLength(4)
    })

    it('returns empty for empty input', () => {
      expect(sliceBeforeMessage([], 'x')).toEqual([])
    })
  })

  describe('prepareHistory', () => {
    it('filters out error messages and appends a new user message', () => {
      const msgs: ChatMessage[] = [
        { id: 'a', role: 'user', content: 'ok' },
        { id: 'b', role: 'assistant', content: '', error: 'fail' }
      ]
      const result = prepareHistory(msgs, 'new message')
      expect(result).toHaveLength(2)
      expect(result[0].id).toBe('a')
      expect(result[1].role).toBe('user')
      expect(result[1].content).toBe('new message')
    })

    it('leaves happy messages intact', () => {
      const msgs: ChatMessage[] = [
        { id: 'a', role: 'user', content: 'hi' },
        { id: 'b', role: 'assistant', content: 'hello' }
      ]
      const result = prepareHistory(msgs, 'next')
      expect(result).toHaveLength(3)
      expect(result.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    })
  })

  describe('flattenMessages', () => {
    it('strips UI-only fields (pending, error)', () => {
      const msgs: ChatMessage[] = [
        { id: 'a', role: 'user', content: 'hi', pending: true },
        { id: 'b', role: 'assistant', content: 'hello', error: 'x' }
      ]
      const flat = flattenMessages(msgs)
      expect(flat).toEqual([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' }
      ])
      // 验证没有 pending/error/id 泄漏
      for (const m of flat) {
        expect(Object.keys(m)).toEqual(['role', 'content'])
      }
    })
  })
})
