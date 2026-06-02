import { describe, expect, it } from 'vitest'
import { normalizeAccountModels } from '../accountModelUtils'

describe('accountModelUtils', () => {
  it('normalizes string model ids returned by refresh-models IPC', () => {
    expect(normalizeAccountModels(['auto', 'gpt-5'])).toEqual([
      { modelId: 'auto', modelName: 'auto', rateMultiplier: 1, rateUnit: 'request' },
      { modelId: 'gpt-5', modelName: 'gpt-5', rateMultiplier: 1, rateUnit: 'request' }
    ])
  })

  it('keeps object models and removes duplicate or empty entries', () => {
    expect(
      normalizeAccountModels([
        { modelId: 'auto', modelName: 'Auto', rateMultiplier: 2, rateUnit: 'credit' },
        { modelId: 'auto', modelName: 'Auto duplicate' },
        { modelName: 'gpt-5' },
        '',
        null
      ])
    ).toEqual([
      { modelId: 'auto', modelName: 'Auto', rateMultiplier: 2, rateUnit: 'credit' },
      { modelId: 'gpt-5', modelName: 'gpt-5', rateMultiplier: 1, rateUnit: 'request' }
    ])
  })
})
