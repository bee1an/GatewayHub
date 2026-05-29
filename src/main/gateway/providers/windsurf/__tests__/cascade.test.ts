import { describe, expect, it } from 'vitest'
import {
  extractWindsurfCascadeError,
  extractWindsurfCascadeResult,
  extractWindsurfModelIds
} from '../cascade'

describe('windsurf/cascade', () => {
  it('extracts model ids from GetUserStatus response', () => {
    const models = extractWindsurfModelIds({
      userStatus: {
        cascadeModelConfigData: {
          clientModelConfigs: [
            { modelUid: 'swe-1-6-slow' },
            { modelInfo: { modelUid: 'claude-sonnet-4-6-thinking' } },
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
})
