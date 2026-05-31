import { describe, expect, it } from 'vitest'
import { listTraeBuiltInModelIds, normalizeTraeModel } from '../constants'

describe('trae/constants', () => {
  it('normalizes the public free chat model aliases', () => {
    expect(normalizeTraeModel('Gemini 2.5 Flash')).toBe('gemini_2.5_flash')
    expect(normalizeTraeModel('gemini_2.5_flash_premium')).toBe('gemini_2.5_flash')
  })

  it('lists only the verified public free model by default', () => {
    expect(listTraeBuiltInModelIds()).toEqual(['gemini_2.5_flash'])
  })

  it('accepts includeUnavailableInUS without publishing unverified configs', () => {
    expect(listTraeBuiltInModelIds({ includeUnavailableInUS: true })).toEqual(['gemini_2.5_flash'])
  })
})
