import { describe, expect, it } from 'vitest'
import { extractTraeLocalChatText, toTraeLocalChatModel } from '../localBridge'

describe('trae/localBridge', () => {
  it('maps legacy free flash alias to the usable local chat_v3 config', () => {
    expect(toTraeLocalChatModel('gemini_2.5_flash')).toBe('gemini_2.5_flash_premium')
    expect(toTraeLocalChatModel('Gemini 2.5 Flash')).toBe('gemini_2.5_flash_premium')
    expect(toTraeLocalChatModel('gemini_2.5_flash_premium')).toBe('gemini_2.5_flash_premium')
  })

  it('extracts final text from Trae v3 plan_item finish events', () => {
    expect(
      extractTraeLocalChatText([
        {
          event: 'plan_item',
          payload: {
            thought: 'draft',
            tool_call_info: { name: '', params: null, result: {} }
          }
        },
        {
          event: 'plan_item',
          payload: {
            thought: '',
            tool_call_info: { name: 'finish', params: { summary: 'OK' }, result: {} }
          }
        }
      ])
    ).toBe('OK')
  })
})
