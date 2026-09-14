import { describe, expect, it } from 'vitest'
import {
  chatCompletionSseToResponsesSse,
  chatCompletionToResponsesResponse,
  responsesRequestToChatCompletions
} from '../responsesApi'

describe('responsesRequestToChatCompletions', () => {
  it('maps string input, instructions, and max_output_tokens', () => {
    const converted = responsesRequestToChatCompletions({
      model: 'gpt-4o',
      instructions: 'You are helpful.',
      input: 'hi',
      max_output_tokens: 64,
      temperature: 0.2
    })

    expect(converted).toMatchObject({
      model: 'gpt-4o',
      stream: false,
      max_completion_tokens: 64,
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'hi' }
      ]
    })
  })

  it('converts message items, function calls and outputs', () => {
    const converted = responsesRequestToChatCompletions({
      model: 'm',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'look' },
            { type: 'input_image', image_url: 'https://img' }
          ]
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'get_weather',
          arguments: '{"city":"sf"}'
        },
        { type: 'function_call_output', call_id: 'call_1', output: 'sunny' }
      ]
    })

    expect(converted.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'https://img' } }
        ]
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"sf"}' }
          }
        ]
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'sunny' }
    ])
  })

  it('maps tools, tool_choice, json schema and reasoning effort', () => {
    const converted = responsesRequestToChatCompletions({
      model: 'm',
      input: 'x',
      tools: [
        {
          type: 'function',
          name: 'fn',
          description: 'd',
          parameters: { type: 'object' },
          strict: true
        },
        { type: 'web_search' }
      ],
      tool_choice: { type: 'function', name: 'fn' },
      text: { format: { type: 'json_schema', name: 'out', schema: { type: 'object' } } },
      reasoning: { effort: 'high' },
      stream: true
    })

    expect(converted.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'fn',
          description: 'd',
          parameters: { type: 'object' },
          strict: true
        }
      }
    ])
    expect(converted.tool_choice).toEqual({ type: 'function', function: { name: 'fn' } })
    expect(converted.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'out', schema: { type: 'object' } }
    })
    expect(converted.reasoning_effort).toBe('high')
    expect(converted.stream_options).toEqual({ include_usage: true })
  })
})

describe('chatCompletionToResponsesResponse', () => {
  it('wraps text, tool calls, usage and status', () => {
    const response = chatCompletionToResponsesResponse(
      {
        id: 'chatcmpl-1',
        created: 1700000000,
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'hello',
              tool_calls: [
                { id: 'call_9', type: 'function', function: { name: 'fn', arguments: '{}' } }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14,
          completion_tokens_details: { reasoning_tokens: 2 }
        }
      },
      { model: 'gpt-4o', instructions: 'sys', max_output_tokens: 99, metadata: { a: 1 } }
    )

    expect(response.id).toMatch(/^resp_/)
    expect(response.object).toBe('response')
    expect(response.status).toBe('completed')
    expect(response.model).toBe('gpt-4o')
    expect(response.instructions).toBe('sys')
    expect(response.max_output_tokens).toBe(99)
    expect(response.metadata).toEqual({ a: 1 })
    expect(response.output_text).toBe('hello')

    const types = response.output.map((item: any) => item.type)
    expect(types).toEqual(['message', 'function_call'])
    expect(response.output[0].content[0]).toMatchObject({ type: 'output_text', text: 'hello' })
    expect(response.output[1]).toMatchObject({
      type: 'function_call',
      call_id: 'call_9',
      name: 'fn',
      arguments: '{}',
      status: 'completed'
    })
    expect(response.usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 4,
      total_tokens: 14,
      output_tokens_details: { reasoning_tokens: 2 }
    })
  })

  it('marks length finish as incomplete with max_output_tokens reason', () => {
    const response = chatCompletionToResponsesResponse(
      { choices: [{ message: { content: 'x' }, finish_reason: 'length' }] },
      {}
    )
    expect(response.status).toBe('incomplete')
    expect(response.incomplete_details).toEqual({ reason: 'max_output_tokens' })
  })
})

describe('chatCompletionSseToResponsesSse', () => {
  it('emits response lifecycle events with text deltas and completed response', async () => {
    const sse = [
      'data: {"id":"c1","model":"m1","choices":[{"delta":{"role":"assistant"},"index":0}]}',
      '',
      'data: {"choices":[{"delta":{"content":"he"},"index":0}]}',
      '',
      'data: {"choices":[{"delta":{"content":"llo"},"index":0}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
      '',
      'data: [DONE]',
      ''
    ].join('\n')

    const events = await collectEvents(streamOf(sse), { model: 'm1' })
    const types = events.map((e) => e.event)

    expect(types).toContain('response.created')
    expect(types).toContain('response.in_progress')
    expect(types).toContain('response.output_item.added')
    expect(types).toContain('response.content_part.added')
    expect(types).toContain('response.output_text.delta')
    expect(types).toContain('response.output_text.done')
    expect(types).toContain('response.completed')

    const deltas = events
      .filter((e) => e.event === 'response.output_text.delta')
      .map((e) => e.data.delta)
    expect(deltas.join('')).toBe('hello')

    const completed = events.find((e) => e.event === 'response.completed')!.data.response
    expect(completed.status).toBe('completed')
    expect(completed.output[0].content[0].text).toBe('hello')
    expect(completed.usage).toMatchObject({ input_tokens: 5, output_tokens: 2 })
    expect(completed.model).toBe('m1')
  })

  it('emits the full reasoning part lifecycle exactly once', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"reasoning_content":"think"},"index":0}]}',
      '',
      'data: {"choices":[{"delta":{"reasoning_content":"ing"},"index":0}]}',
      '',
      'data: {"choices":[{"delta":{"content":"done"},"index":0}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
      '',
      'data: [DONE]',
      ''
    ].join('\n')

    const events = await collectEvents(streamOf(sse), {})
    const types = events.map((e) => e.event)

    expect(types.filter((t) => t === 'response.reasoning_summary_part.added')).toHaveLength(1)
    expect(types.filter((t) => t === 'response.reasoning_summary_text.done')).toHaveLength(1)
    expect(types.filter((t) => t === 'response.reasoning_summary_part.done')).toHaveLength(1)
    // reasoning item added before message item, and each item.done fires once
    expect(types.filter((t) => t === 'response.output_item.added')).toHaveLength(2)
    expect(types.filter((t) => t === 'response.output_item.done')).toHaveLength(2)
    const added = events.find((e) => e.event === 'response.reasoning_summary_part.added')!
    expect(added.data.part).toEqual({ type: 'summary_text', text: '' })
    const done = events.find((e) => e.event === 'response.reasoning_summary_text.done')!
    expect(done.data.text).toBe('thinking')
    const completed = events.find((e) => e.event === 'response.completed')!.data.response
    expect(completed.output[0]).toMatchObject({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'thinking' }]
    })
  })

  it('emits function_call items with argument deltas', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"fn","arguments":"{\\"a\\""}}]},"index":0}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]},"index":0}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}]}',
      '',
      'data: [DONE]',
      ''
    ].join('\n')

    const events = await collectEvents(streamOf(sse), {})
    const argDeltas = events
      .filter((e) => e.event === 'response.function_call_arguments.delta')
      .map((e) => e.data.delta)
    expect(argDeltas.join('')).toBe('{"a":1}')

    const done = events.find(
      (e) => e.event === 'response.output_item.done' && e.data.item.type === 'function_call'
    )
    expect(done?.data.item).toMatchObject({
      call_id: 'call_1',
      name: 'fn',
      arguments: '{"a":1}',
      status: 'completed'
    })
    const completed = events.find((e) => e.event === 'response.completed')!.data.response
    expect(completed.output.map((i: any) => i.type)).toEqual(['function_call'])
  })

  it('maps upstream error payload to response.failed', async () => {
    const sse = 'data: {"error":{"type":"rate_limit","message":"slow down"}}\n\ndata: [DONE]\n\n'
    const events = await collectEvents(streamOf(sse), {})
    const failed = events.find((e) => e.event === 'response.failed')
    expect(failed?.data.response.status).toBe('failed')
    expect(failed?.data.response.error.code).toBe('rate_limit')
    expect(events.some((e) => e.event === 'response.completed')).toBe(false)
  })
})

function streamOf(text: string): AsyncIterable<string> {
  return (async function* () {
    yield text
  })()
}

async function collectEvents(
  source: AsyncIterable<string>,
  requestBody: any
): Promise<{ event: string; data: any }[]> {
  const events: { event: string; data: any }[] = []
  let buffer = ''
  for await (const chunk of chatCompletionSseToResponsesSse(source, requestBody)) {
    buffer += chunk
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      const eventLine = block.split('\n').find((l) => l.startsWith('event: '))
      const dataLine = block.split('\n').find((l) => l.startsWith('data: '))
      if (eventLine && dataLine) {
        events.push({ event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) })
      }
    }
  }
  return events
}
