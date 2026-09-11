import { describe, expect, it } from 'vitest'
import {
  anthropicJsonFromResult,
  anthropicSseFromEvents,
  openAiJsonFromResult,
  openAiSseFromEvents
} from '../streaming'
import type { TraeWorkChatResult, TraeWorkStreamEvent } from '../rawChat'

async function* events(items: TraeWorkStreamEvent[]): AsyncGenerator<TraeWorkStreamEvent> {
  for (const item of items) yield item
}

const UPSTREAM: TraeWorkStreamEvent[] = [
  {
    event: 'output',
    data: { response: '', reasoning_content: 'thinking', tool_calls: null }
  },
  { event: 'output', data: { response: 'Hello', reasoning_content: null, tool_calls: null } },
  { event: 'output', data: { response: ' world', reasoning_content: null, tool_calls: null } },
  {
    event: 'token_usage',
    data: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  },
  { event: 'done', data: { finish_reason: 'stop' } }
]

describe('traework/streaming', () => {
  it('emits OpenAI chunks with reasoning, content and usage', async () => {
    const chunks: string[] = []
    let reported: any
    for await (const chunk of openAiSseFromEvents(events(UPSTREAM), 'glm-5.3', {}, (u) => {
      reported = u
    })) {
      chunks.push(chunk)
    }
    const joined = chunks.join('')
    expect(joined).toContain('"role":"assistant"')
    expect(joined).toContain('"reasoning_content":"thinking"')
    expect(joined).toContain('"content":"Hello"')
    expect(joined).toContain('"content":" world"')
    expect(joined).toContain('"finish_reason":"stop"')
    expect(joined).toContain('"prompt_tokens":10')
    expect(joined).toContain('data: [DONE]')
    expect(reported).toMatchObject({ inputTokens: 10, outputTokens: 5 })
  })

  it('emits Anthropic events with thinking + text blocks', async () => {
    const chunks: string[] = []
    for await (const chunk of anthropicSseFromEvents(events(UPSTREAM), 'glm-5.3', {})) {
      chunks.push(chunk)
    }
    const joined = chunks.join('')
    expect(joined).toContain('event: message_start')
    expect(joined).toContain('"type":"thinking"')
    expect(joined).toContain('"type":"thinking_delta"')
    expect(joined).toContain('"type":"text_delta"')
    expect(joined).toContain('event: message_delta')
    expect(joined).toContain('"stop_reason":"end_turn"')
    expect(joined).toContain('"input_tokens":10')
    expect(joined).toContain('event: message_stop')
  })

  it('maps tool_calls to OpenAI deltas and Anthropic tool_use blocks', async () => {
    const withTools: TraeWorkStreamEvent[] = [
      {
        event: 'output',
        data: {
          response: '',
          reasoning_content: null,
          tool_calls: [
            {
              index: 0,
              id: 'call_abc',
              type: 'function',
              function_call: { name: 'get_weather', arguments: '{"city":"BJ"}' }
            }
          ]
        }
      },
      { event: 'token_usage', data: { prompt_tokens: 4, completion_tokens: 3 } },
      { event: 'done', data: { finish_reason: 'stop' } }
    ]
    const openaiChunks: string[] = []
    for await (const chunk of openAiSseFromEvents(events(withTools), 'glm-5.3', {})) {
      openaiChunks.push(chunk)
    }
    const joined = openaiChunks.join('')
    expect(joined).toContain('"name":"get_weather"')
    expect(joined).toContain('"arguments":"{\\"city\\":\\"BJ\\"}"')
    expect(joined).toContain('"finish_reason":"tool_calls"')

    const anthropicChunks: string[] = []
    for await (const chunk of anthropicSseFromEvents(events(withTools), 'glm-5.3', {})) {
      anthropicChunks.push(chunk)
    }
    const joinedA = anthropicChunks.join('')
    expect(joinedA).toContain('"type":"tool_use"')
    expect(joinedA).toContain('"name":"get_weather"')
    expect(joinedA).toContain('"type":"input_json_delta"')
    expect(joinedA).toContain('"stop_reason":"tool_use"')
  })

  it('builds OpenAI JSON from collected result', () => {
    const result: TraeWorkChatResult = {
      text: 'PONG',
      reasoning: 'user asked for ping',
      usage: { inputTokens: 9, outputTokens: 4, estimated: false },
      finishReason: 'stop',
      rawEvents: []
    }
    const json = openAiJsonFromResult(result, 'glm-5.3', {})
    expect(json.object).toBe('chat.completion')
    expect(json.choices[0].message.content).toBe('PONG')
    expect(json.choices[0].message.reasoning_content).toBe('user asked for ping')
    expect(json.usage.prompt_tokens).toBe(9)
    expect(json.choices[0].finish_reason).toBe('stop')
  })

  it('builds Anthropic JSON with thinking + text blocks', () => {
    const result: TraeWorkChatResult = {
      text: 'PONG',
      reasoning: 'why',
      usage: { inputTokens: 9, outputTokens: 4, estimated: false },
      finishReason: 'stop',
      rawEvents: []
    }
    const json = anthropicJsonFromResult(result, 'glm-5.3', {})
    expect(json.type).toBe('message')
    expect(json.content[0]).toMatchObject({ type: 'thinking', thinking: 'why' })
    expect(json.content[1]).toMatchObject({ type: 'text', text: 'PONG' })
    expect(json.stop_reason).toBe('end_turn')
    expect(json.usage).toMatchObject({ input_tokens: 9, output_tokens: 4 })
  })
})
