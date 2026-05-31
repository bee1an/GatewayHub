import { describe, expect, it } from 'vitest'
import { classifyGptWebError } from '../accountPool'

describe('gptWeb/accountPool', () => {
  it('does not classify GptWeb anti-abuse 403 as quota exhaustion', () => {
    expect(
      classifyGptWebError(
        new Error('GptWeb API error 403: Unusual activity has been detected from your device')
      )
    ).toMatchObject({ kind: 'rate_limit' })
  })

  it('classifies fetch failed as a network error', () => {
    expect(classifyGptWebError(new Error('fetch failed'))).toMatchObject({ kind: 'network' })
  })
})
