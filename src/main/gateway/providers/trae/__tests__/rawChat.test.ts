import { describe, expect, it } from 'vitest'
import { DEFAULT_TRAE_SETTINGS } from '../constants'
import { parseTraeSse, readTraeSseStream, TraeUpstreamError } from '../rawChat'

function delayedStream(
  chunks: Array<{ delayMs: number; text: string }>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let cancelled = false
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        setTimeout(() => {
          if (cancelled) return
          controller.enqueue(encoder.encode(chunk.text))
          if (chunk === chunks[chunks.length - 1]) controller.close()
        }, chunk.delayMs)
      }
    },
    cancel() {
      cancelled = true
    }
  })
}

describe('trae/rawChat', () => {
  it('extracts text deltas and usage from SSE', () => {
    const result = parseTraeSse(
      [
        'event: output',
        'data: {"delta":"hel"}',
        '',
        'event: output',
        'data: {"delta":"lo"}',
        '',
        'event: token_usage',
        'data: {"usage":{"input_tokens":4,"output_tokens":2}}',
        '',
        'event: done',
        'data: [DONE]',
        ''
      ].join('\n')
    )
    expect(result.text).toBe('hello')
    expect(result.usage).toMatchObject({ inputTokens: 4, outputTokens: 2, estimated: false })
  })

  it('throws user-visible upstream errors when no text was produced', () => {
    expect(() =>
      parseTraeSse('event: error\ndata: {"code":1001,"message":"auth"}\n\n', 200)
    ).toThrow(TraeUpstreamError)
  })

  it('accumulates OpenAI-style tool call deltas', () => {
    const result = parseTraeSse(
      [
        'event: output',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Write","arguments":"{\\"file_path\\":"}}]}}]}',
        '',
        'event: output',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"/tmp/a.txt\\",\\"content\\":\\"ok\\"}"}}]}}]}',
        '',
        'event: done',
        'data: [DONE]',
        ''
      ].join('\n')
    )

    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'Write', input: { file_path: '/tmp/a.txt', content: 'ok' } }
    ])
  })

  it('extracts Anthropic-style tool use blocks', () => {
    const result = parseTraeSse(
      'event: output\ndata: {"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"pwd"}}]}\n\n'
    )

    expect(result.toolCalls).toEqual([{ id: 'toolu_1', name: 'Bash', input: { command: 'pwd' } }])
  })

  it('accumulates Anthropic streaming tool_use deltas', () => {
    const result = parseTraeSse(
      [
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash","input":{}}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":"}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"pwd\\"}"}}',
        '',
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":0}',
        ''
      ].join('\n')
    )

    expect(result.toolCalls).toEqual([{ id: 'toolu_1', name: 'Bash', input: { command: 'pwd' } }])
  })

  it('uses firstTokenTimeoutSeconds only for the first stream chunk', async () => {
    const text = await readTraeSseStream(
      delayedStream([
        { delayMs: 0, text: 'event: output\ndata: {"delta":"hel"}\n\n' },
        { delayMs: 30, text: 'event: output\ndata: {"delta":"lo"}\n\n' }
      ]),
      {
        ...DEFAULT_TRAE_SETTINGS,
        firstTokenTimeoutSeconds: 0.01,
        streamingReadTimeoutSeconds: 0.05
      }
    )

    expect(parseTraeSse(text).text).toBe('hello')
  })

  it('fails when the first Trae stream chunk exceeds firstTokenTimeoutSeconds', async () => {
    await expect(
      readTraeSseStream(
        delayedStream([{ delayMs: 30, text: 'event: output\ndata: {"delta":"x"}\n\n' }]),
        {
          ...DEFAULT_TRAE_SETTINGS,
          firstTokenTimeoutSeconds: 0.01,
          streamingReadTimeoutSeconds: 0.05
        }
      )
    ).rejects.toThrow('No Trae token within 0.01s')
  })
})
