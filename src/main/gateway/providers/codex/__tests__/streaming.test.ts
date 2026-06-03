import { describe, expect, it } from 'vitest'
import {
  anthropicJsonFromCodex,
  extractUpstreamUsage,
  openAiJsonFromCodex,
  parseCodexStream
} from '../streaming'

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
}

describe('codex/streaming', () => {
  it('extractUpstreamUsage handles cached_input_tokens flat field', () => {
    const usage = extractUpstreamUsage({
      input_tokens: 1000,
      output_tokens: 500,
      cached_input_tokens: 200
    })
    expect(usage).toMatchObject({
      // input - cached
      inputTokens: 800,
      outputTokens: 500,
      cacheReadTokens: 200
    })
  })

  it('extractUpstreamUsage handles input_tokens_details.cached_tokens', () => {
    const usage = extractUpstreamUsage({
      input_tokens: 100,
      output_tokens: 50,
      input_tokens_details: { cached_tokens: 30 }
    })
    expect(usage).toMatchObject({ inputTokens: 70, outputTokens: 50, cacheReadTokens: 30 })
  })

  it('extractUpstreamUsage falls back to prompt_tokens / completion_tokens', () => {
    const usage = extractUpstreamUsage({ prompt_tokens: 10, completion_tokens: 20 })
    expect(usage).toMatchObject({ inputTokens: 10, outputTokens: 20 })
  })

  it('extractUpstreamUsage returns undefined for empty', () => {
    expect(extractUpstreamUsage(undefined)).toBeUndefined()
    expect(extractUpstreamUsage({})).toBeUndefined()
  })

  it('parseCodexStream emits text deltas and usage', async () => {
    const stream = makeStream([
      'event: response.output_text.delta\n',
      'data: {"delta":"Hello "}\n\n',
      'event: response.output_text.delta\n',
      'data: {"delta":"world"}\n\n',
      'event: response.completed\n',
      'data: {"response":{"model":"gpt-5","usage":{"input_tokens":5,"output_tokens":2}}}\n\n'
    ])
    const events: any[] = []
    for await (const event of parseCodexStream(stream, 30)) events.push(event)
    expect(events.filter((e) => e.type === 'text')).toEqual([
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' }
    ])
    const usageEvent = events.find((e) => e.type === 'usage')
    expect(usageEvent.usage).toMatchObject({ input_tokens: 5, output_tokens: 2 })
  })

  it('openAiJsonFromCodex aggregates reasoning and tool arguments by item_id aliases', async () => {
    const stream = makeStream([
      'event: response.reasoning_summary_text.delta\n',
      'data: {"delta":"thinking"}\n\n',
      'event: response.output_item.added\n',
      'data: {"item":{"id":"item_1","type":"function_call","call_id":"call_1","name":"lookup"}}\n\n',
      'event: response.function_call_arguments.delta\n',
      'data: {"item_id":"item_1","delta":"{\\"q\\":"}\n\n',
      'event: response.function_call_arguments.delta\n',
      'data: {"item_id":"item_1","delta":"\\"x\\"}"}\n\n',
      'event: response.output_item.done\n',
      'data: {"item":{"id":"item_1","type":"function_call","call_id":"call_1","name":"lookup"}}\n\n',
      'event: response.completed\n',
      'data: {"response":{"usage":{"input_tokens":10,"output_tokens":3}}}\n\n'
    ])

    const result = await openAiJsonFromCodex(stream, 'gpt-5', 30)
    const message = result.choices[0].message
    expect(message.reasoning_content).toBe('thinking')
    expect(message.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"q":"x"}' }
      }
    ])
    expect(result.choices[0].finish_reason).toBe('tool_calls')
  })

  it('anthropicJsonFromCodex aggregates tool_use input by item_id aliases', async () => {
    const stream = makeStream([
      'event: response.output_item.added\n',
      'data: {"item":{"id":"item_1","type":"function_call","call_id":"call_1","name":"lookup"}}\n\n',
      'event: response.function_call_arguments.delta\n',
      'data: {"item_id":"item_1","delta":"{\\"q\\":\\"x\\"}"}\n\n',
      'event: response.output_item.done\n',
      'data: {"item":{"id":"item_1","type":"function_call","call_id":"call_1","name":"lookup"}}\n\n',
      'event: response.completed\n',
      'data: {"response":{"usage":{"input_tokens":10,"output_tokens":3}}}\n\n'
    ])

    const result = await anthropicJsonFromCodex(stream, 'gpt-5', 30)
    expect(result.content).toContainEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'lookup',
      input: { q: 'x' }
    })
    expect(result.stop_reason).toBe('tool_use')
  })

  it('openAiJsonFromCodex aggregates text and forwards usage', async () => {
    const stream = makeStream([
      'event: response.output_text.delta\n',
      'data: {"delta":"foo"}\n\n',
      'event: response.output_text.delta\n',
      'data: {"delta":"bar"}\n\n',
      'event: response.completed\n',
      'data: {"response":{"usage":{"input_tokens":10,"output_tokens":3,"cached_input_tokens":2}}}\n\n'
    ])
    let captured: any
    const result = await openAiJsonFromCodex(stream, 'gpt-5', 30, (u) => {
      captured = u
    })
    expect(result.choices[0].message.content).toBe('foobar')
    expect(captured).toMatchObject({ inputTokens: 8, outputTokens: 3, cacheReadTokens: 2 })
    // OpenAI usage: prompt_tokens = inputTokens + cached
    expect(result.usage.prompt_tokens).toBe(10)
    expect(result.usage.completion_tokens).toBe(3)
    expect(result.usage.prompt_tokens_details).toEqual({ cached_tokens: 2 })
  })

  it('anthropicJsonFromCodex returns Anthropic shape', async () => {
    const stream = makeStream([
      'event: response.output_text.delta\n',
      'data: {"delta":"hi"}\n\n',
      'event: response.completed\n',
      'data: {"response":{"usage":{"input_tokens":4,"output_tokens":1}}}\n\n'
    ])
    const result = await anthropicJsonFromCodex(stream, 'gpt-5', 30)
    expect(result.type).toBe('message')
    expect(result.content[0]).toEqual({ type: 'text', text: 'hi' })
    expect(result.usage).toMatchObject({ input_tokens: 4, output_tokens: 1 })
  })
})
