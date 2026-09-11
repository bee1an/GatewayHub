import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  anthropicMessagesToOpenAIChatCompletions,
  openAIChatCompletionSseToAnthropicMessageSse,
  openAIChatCompletionToAnthropicMessage
} from '../protocolAdapters'

describe('protocolAdapters', () => {
  it('converts Anthropic messages requests to OpenAI chat completions requests', () => {
    const result = anthropicMessagesToOpenAIChatCompletions(
      {
        model: 'provider/model',
        system: [{ type: 'text', text: 'be concise' }],
        max_tokens: 32,
        stop_sequences: ['END'],
        tools: [
          {
            name: 'read_file',
            description: 'Read a file',
            input_schema: { type: 'object', properties: { path: { type: 'string' } } }
          }
        ],
        tool_choice: { type: 'tool', name: 'read_file' },
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'calling' },
              { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.txt' } }
            ]
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }]
          }
        ]
      },
      'model'
    )

    expect(result).toMatchObject({
      model: 'model',
      max_tokens: 32,
      stop: ['END'],
      messages: [
        { role: 'system', content: 'be concise' },
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: 'calling',
          tool_calls: [
            {
              id: 'toolu_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"a.txt"}' }
            }
          ]
        },
        { role: 'tool', tool_call_id: 'toolu_1', content: 'ok' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } }
          }
        }
      ],
      tool_choice: { type: 'function', function: { name: 'read_file' } }
    })
  })

  it('converts OpenAI chat completions JSON to Anthropic messages JSON', () => {
    const result = openAIChatCompletionToAnthropicMessage(
      {
        id: 'chatcmpl_1',
        model: 'upstream-model',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: 'done',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'write_file', arguments: '{"path":"a.txt"}' }
                }
              ]
            }
          }
        ],
        usage: { prompt_tokens: 5, completion_tokens: 7 }
      },
      'fallback-model'
    )

    expect(result).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: 'upstream-model',
      content: [
        { type: 'text', text: 'done' },
        { type: 'tool_use', id: 'call_1', name: 'write_file', input: { path: 'a.txt' } }
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 7 }
    })
  })

  it('converts OpenAI streaming chunks to Anthropic message events', async () => {
    async function* source(): AsyncGenerator<string> {
      yield 'data: {"id":"chatcmpl_1","model":"m","choices":[{"delta":{"role":"assistant","content":"H"},"finish_reason":null}]}\n\n'
      yield 'data: {"choices":[{"delta":{"content":"I"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\n'
      yield 'data: [DONE]\n\n'
    }

    const output = (
      await collect(openAIChatCompletionSseToAnthropicMessageSse(source(), 'm'))
    ).join('')

    expect(output).toContain('event: message_start')
    expect(output).toContain('event: content_block_start')
    expect(output).toContain('"text":"H"')
    expect(output).toContain('"text":"I"')
    expect(output).toContain('"stop_reason":"end_turn"')
    expect(output).toContain('"input_tokens":2')
    expect(output).toContain('"output_tokens":3')
    expect(output).toContain('event: message_stop')
  })

  it('parses CRLF, multi-line data, comments, and UTF-8 split across chunks', async () => {
    const encoder = new TextEncoder()
    const frame =
      ': keepalive\r\ndata: {"choices":[{"delta":{"content":"你"},\r\ndata: "finish_reason":null}]}\r\n\r\ndata: [DONE]\r\n\r\n'
    const bytes = encoder.encode(frame)
    const splitAt = bytes.indexOf(0xe4) + 1

    async function* source(): AsyncGenerator<Uint8Array> {
      yield bytes.slice(0, splitAt)
      yield bytes.slice(splitAt)
    }

    const output = (
      await collect(openAIChatCompletionSseToAnthropicMessageSse(source(), 'm'))
    ).join('')

    expect(output).toContain('"text":"你"')
    expect(output).toContain('event: message_stop')
  })

  it('produces the same result for arbitrary byte chunking', async () => {
    const bytes = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"你好 SSE"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    )
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 1, max: bytes.length - 1 })),
        async (cuts) => {
          const boundaries = [0, ...cuts.sort((a, b) => a - b), bytes.length]
          async function* source(): AsyncGenerator<Uint8Array> {
            for (let index = 1; index < boundaries.length; index++) {
              yield bytes.slice(boundaries[index - 1], boundaries[index])
            }
          }
          const output = (
            await collect(openAIChatCompletionSseToAnthropicMessageSse(source(), 'm'))
          ).join('')
          expect(output).toContain('"text":"你好 SSE"')
          expect(output).toContain('event: message_stop')
        }
      ),
      { numRuns: 50 }
    )
  })
})

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}
