import { describe, expect, it, vi } from 'vitest'
import {
  extractWindsurfCascadeError,
  extractWindsurfCascadeResult,
  extractWindsurfModelIds,
  runWindsurfCascadeStream,
  toCascadeImages
} from '../cascade'

describe('windsurf/cascade', () => {
  it('extracts model ids from GetUserStatus response', () => {
    const models = extractWindsurfModelIds({
      userStatus: {
        cascadeModelConfigData: {
          clientModelConfigs: [
            { modelUid: 'swe-1-6-slow' },
            { modelInfo: { modelUid: 'claude-sonnet-4-6-thinking' } },
            { modelUid: 'disabled-model', disabled: true },
            {
              modelUid: 'MODEL_CLAUDE_4_SONNET_BYOK',
              pricingType: 'MODEL_PRICING_TYPE_BYOK'
            },
            { label: 'label-model' }
          ]
        }
      }
    })
    expect(models).toEqual(['claude-sonnet-4-6-thinking', 'label-model', 'swe-1-6-slow'])
  })

  it('extracts the final planner response and usage from a Cascade trajectory', () => {
    const result = extractWindsurfCascadeResult(
      {
        trajectory: {
          steps: [
            { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'hi' } },
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              metadata: { inputTokens: '12', outputTokens: '3' },
              plannerResponse: { response: 'hello', modifiedResponse: 'hello!' }
            }
          ]
        }
      },
      'hi'
    )
    expect(result).toMatchObject({
      text: 'hello!',
      usage: { inputTokens: 12, outputTokens: 3, estimated: false }
    })
  })

  it('extracts structured tool calls, inline tool calls, cache usage, and workspace edits', () => {
    const result = extractWindsurfCascadeResult(
      {
        status: 'CASCADE_RUN_STATUS_IDLE',
        workspaceEdits: [{ repoRoot: '/repo', numAdditions: 2, numDeletions: 1, edits: [{}] }],
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              metadata: {
                inputTokens: 20,
                outputTokens: 5,
                cacheReadTokens: 7,
                cacheWriteTokens: 3,
                toolCall: { id: 'call_meta', name: 'MetaTool', argumentsJson: '{"a":1}' }
              },
              plannerResponse: {
                response:
                  'Done\n<tool_call>{"id":"call_1","name":"lookup","arguments":{"q":"x"}}</tool_call>',
                toolCalls: [{ id: 'call_2', name: 'Write', argumentsJson: '{"content":"ok"}' }]
              }
            }
          ]
        }
      },
      'prompt'
    )

    expect(result?.text).toBe('Done')
    expect(result?.usage).toMatchObject({
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 7,
      cacheWrite5mTokens: 3,
      estimated: false
    })
    expect(result?.toolCalls).toEqual([
      { id: 'call_2', name: 'Write', input: { content: 'ok' } },
      { id: 'call_meta', name: 'MetaTool', input: { a: 1 } },
      { id: 'call_1', name: 'lookup', input: { q: 'x' } }
    ])
    expect(result?.workspaceEdits?.[0]).toMatchObject({
      repoRoot: '/repo',
      numAdditions: 2,
      numDeletions: 1
    })
  })

  it('extracts user-facing Cascade error messages', () => {
    const message = extractWindsurfCascadeError({
      trajectory: {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            error: {
              error: {
                userErrorMessage: 'Model is temporarily unavailable. Please try again later.',
                shortError: 'permission_denied'
              }
            }
          }
        ]
      }
    })
    expect(message).toBe('Model is temporarily unavailable. Please try again later.')
  })

  it('maps base64 attachments to Cascade ImageData JSON fields', () => {
    expect(
      toCascadeImages([{ mimeType: 'image/png', base64Data: ' abc ', caption: 'screenshot' }])
    ).toEqual([{ base64Data: 'abc', mimeType: 'image/png', caption: 'screenshot' }])
  })

  it('polls Cascade in non-blocking mode and emits append-only text deltas', async () => {
    vi.useFakeTimers()
    const calls: any[] = []
    let poll = 0
    const client = {
      metadata: () => ({ requestId: '1' }),
      unary: vi.fn(async (method: string, body: any) => {
        calls.push({ method, body })
        if (method === 'GetUserStatus') return { userStatus: {} }
        if (method === 'UpdatePanelStateWithUserStatus') return {}
        if (method === 'StartCascade') return { cascadeId: 'cascade_1' }
        if (method === 'SendUserCascadeMessage') return {}
        if (method === 'GetCascadeTrajectory') {
          poll += 1
          return {
            status: poll > 1 ? 'CASCADE_RUN_STATUS_IDLE' : 'CASCADE_RUN_STATUS_RUNNING',
            trajectory: {
              steps: [
                {
                  type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                  plannerResponse: { response: poll > 1 ? 'Hello' : 'Hel' }
                }
              ]
            }
          }
        }
        throw new Error(method)
      }),
      getCapturedCascadeEdits: () => [
        {
          uri: 'file:///tmp/example.txt',
          targetContent: 'hello\nworld',
          cascadeId: 'cascade_1',
          gitWorktreePath: '/tmp',
          receivedAt: 1
        }
      ]
    } as any

    try {
      const iterator = runWindsurfCascadeStream(
        client,
        { prompt: 'Hi', images: [{ base64Data: 'abc', mimeType: 'image/png' }] },
        'swe-1-6-slow',
        {
          launchTimeoutSeconds: 20,
          firstTokenTimeoutSeconds: 60,
          streamingReadTimeoutSeconds: 120
        } as any
      )
      const first = (await iterator.next()).value as any
      expect(first.textDelta).toBe('Hel')
      const secondPromise = iterator.next()
      await vi.advanceTimersByTimeAsync(700)
      const second = (await secondPromise).value as any
      expect(second.textDelta).toBe('lo')
      const done = (await iterator.next()).value as any
      expect(done.done).toBe(true)
      expect(done.workspaceEdits?.[0]).toMatchObject({
        repoRoot: '/tmp',
        numAdditions: 2,
        captured: true
      })
      expect(calls.find((call) => call.method === 'SendUserCascadeMessage')?.body).toMatchObject({
        cascadeId: 'cascade_1',
        blocking: false,
        images: [{ base64Data: 'abc', mimeType: 'image/png' }]
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
