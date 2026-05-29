import { describe, expect, it } from 'vitest'
import { buildKiroPayloadFromAnthropic } from '../converters'
import { anthropicJsonFromKiro } from '../streaming'

const writeTool = {
  name: 'Write',
  description: 'Writes a file to the local filesystem.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      content: { type: 'string' }
    },
    required: ['file_path', 'content']
  }
}

const bashTool = {
  name: 'Bash',
  description: 'Executes a shell command.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      description: { type: 'string' }
    },
    required: ['command']
  }
}

function kiroStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    }
  })
}

function toolResultStatus(isError: boolean | undefined): string {
  const payload = buildKiroPayloadFromAnthropic(
    {
      model: 'claude-opus-4.6',
      max_tokens: 128,
      tools: [writeTool],
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tooluse_1', name: 'Write', input: {} }]
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tooluse_1',
              is_error: isError,
              content: 'InputValidationError: missing required parameters'
            }
          ]
        }
      ]
    },
    'claude-opus-4.6'
  )

  return payload.conversationState.currentMessage.userInputMessage.userInputMessageContext
    .toolResults[0].status
}

describe('Kiro Anthropic converter', () => {
  it('preserves Anthropic tool_result error status for Kiro', () => {
    expect(toolResultStatus(true)).toBe('error')
  })

  it('keeps non-error Anthropic tool_result status as success', () => {
    expect(toolResultStatus(false)).toBe('success')
    expect(toolResultStatus(undefined)).toBe('success')
  })

  it('does not convert a name-prefixed Kiro tool stop frame into an empty tool use', async () => {
    const result = await anthropicJsonFromKiro(
      kiroStream('{"name":"Bash","stop":true,"toolUseId":"tooluse_1"}'),
      'claude-opus-4.6',
      { tools: [bashTool], messages: [] },
      1
    )

    expect(result.stop_reason).toBe('end_turn')
    expect(result.content).toEqual([])
  })

  it('parses Kiro Bash input chunks followed by a name-prefixed stop frame', async () => {
    const result = await anthropicJsonFromKiro(
      kiroStream(
        '{"name":"Bash","toolUseId":"tooluse_1"}' +
          '{"input":"","name":"Bash","toolUseId":"tooluse_1"}' +
          '{"input":"{\\"command\\":\\"echo hi\\",\\"description\\":\\"say hi\\"}","name":"Bash","toolUseId":"tooluse_1"}' +
          '{"name":"Bash","stop":true,"toolUseId":"tooluse_1"}'
      ),
      'claude-opus-4.6',
      { tools: [bashTool], messages: [] },
      1
    )

    expect(result.stop_reason).toBe('tool_use')
    expect(result.content).toEqual([
      {
        type: 'tool_use',
        id: 'tooluse_1',
        name: 'Bash',
        input: { command: 'echo hi', description: 'say hi' }
      }
    ])
  })

  it('keeps a truncated Kiro tool call as an invalid empty input for downstream tool validation', async () => {
    const result = await anthropicJsonFromKiro(
      kiroStream(
        '{"name":"Write","toolUseId":"tooluse_1"}' +
          '{"input":"{\\"file_path\\":\\"/tmp/zh.md\\"","name":"Write","toolUseId":"tooluse_1"}'
      ),
      'claude-opus-4.6',
      { tools: [writeTool], messages: [] },
      1
    )

    expect(result.stop_reason).toBe('tool_use')
    expect(result.content).toEqual([
      {
        type: 'tool_use',
        id: 'tooluse_1',
        name: 'Write',
        input: {}
      }
    ])
  })
})
