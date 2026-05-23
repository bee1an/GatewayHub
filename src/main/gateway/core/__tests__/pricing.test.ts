import { describe, expect, it } from 'vitest'
import { PricingTable } from '../pricing'

describe('PricingTable.resolve', () => {
  const table = new PricingTable()

  it('exact match', () => {
    const price = table.resolve('claude-sonnet-4-5')
    expect(price?.inputPerMTokens).toBe(3)
    expect(price?.outputPerMTokens).toBe(15)
    expect(price?.cacheReadPerMTokens).toBe(0.3)
  })

  it('strips provider prefix', () => {
    const price = table.resolve('kiro/claude-haiku-4-5')
    expect(price?.inputPerMTokens).toBe(1)
  })

  it('falls back along version suffix', () => {
    const price = table.resolve('claude-sonnet-4-5-20250920')
    expect(price?.inputPerMTokens).toBe(3)
  })

  it('strips trailing decimal in last segment', () => {
    // Kiro 把版本号嵌进尾段（如 claude-opus-4.7），价格表只有 claude-opus-4
    const price = table.resolve('claude-opus-4.7')
    expect(price?.inputPerMTokens).toBe(15)
  })

  it('strips trailing decimal with extra suffix', () => {
    const price = table.resolve('claude-sonnet-4.6-preview')
    expect(price?.inputPerMTokens).toBe(3)
  })

  it('returns undefined for unknown model', () => {
    expect(table.resolve('mystery-model-9000')).toBeUndefined()
    expect(table.resolve(undefined)).toBeUndefined()
  })

  it('case insensitive', () => {
    const price = table.resolve('Claude-Opus-4-1')
    expect(price?.inputPerMTokens).toBe(15)
  })
})

describe('PricingTable.compute', () => {
  const table = new PricingTable()

  it('plain input + output', () => {
    const cost = table.compute('claude-sonnet-4-5', {
      inputTokens: 1_000_000,
      outputTokens: 500_000
    })
    expect(cost.inputUsd).toBeCloseTo(3, 5)
    expect(cost.outputUsd).toBeCloseTo(7.5, 5)
    expect(cost.cacheReadUsd).toBe(0)
    expect(cost.cacheWriteUsd).toBe(0)
    expect(cost.creditsUsd).toBe(0)
    expect(cost.totalUsd).toBeCloseTo(10.5, 5)
    expect(cost.currency).toBe('USD')
    expect(cost.basis).toBe('token')
  })

  it('cache read at 0.1x', () => {
    const cost = table.compute('claude-sonnet-4-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000
    })
    expect(cost.cacheReadUsd).toBeCloseTo(0.3, 5)
    expect(cost.totalUsd).toBeCloseTo(0.3, 5)
  })

  it('5m + 1h cache writes use different prices', () => {
    const cost = table.compute('claude-sonnet-4-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheWrite5mTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000
    })
    expect(cost.cacheWriteUsd).toBeCloseTo(3.75 + 6, 5)
  })

  it('mixed input + cache + output', () => {
    const cost = table.compute('claude-opus-4-1', {
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 1_000_000,
      cacheWrite5mTokens: 100_000
    })
    // input 100 * 15/1M, output 200 * 75/1M, cache_read 1M * 1.5, cache_write 100k * 18.75
    expect(cost.inputUsd).toBeCloseTo((100 * 15) / 1e6, 8)
    expect(cost.outputUsd).toBeCloseTo((200 * 75) / 1e6, 8)
    expect(cost.cacheReadUsd).toBeCloseTo(1.5, 5)
    expect(cost.cacheWriteUsd).toBeCloseTo((100_000 * 18.75) / 1e6, 5)
  })

  it('unknown model returns zeros', () => {
    const cost = table.compute('mystery', { inputTokens: 100, outputTokens: 200 })
    expect(cost.totalUsd).toBe(0)
    expect(cost.currency).toBe('USD')
    expect(cost.basis).toBe('none')
  })

  it('undefined model returns zeros', () => {
    const cost = table.compute(undefined, { inputTokens: 100, outputTokens: 200 })
    expect(cost.totalUsd).toBe(0)
    expect(cost.basis).toBe('none')
  })

  it('undefined usage returns zeros', () => {
    const cost = table.compute('claude-sonnet-4-5', undefined)
    expect(cost.totalUsd).toBe(0)
    expect(cost.basis).toBe('none')
  })
})

describe('PricingTable overrides', () => {
  it('override replaces builtin', () => {
    const table = new PricingTable({
      'claude-sonnet-4-5': {
        inputPerMTokens: 99,
        outputPerMTokens: 100
      }
    })
    const price = table.resolve('claude-sonnet-4-5')
    expect(price?.inputPerMTokens).toBe(99)
    expect(price?.cacheReadPerMTokens).toBeUndefined()
  })

  it('override adds new model', () => {
    const table = new PricingTable({
      'custom-llm-7b': { inputPerMTokens: 0.5, outputPerMTokens: 1.5 }
    })
    expect(table.resolve('custom-llm-7b')?.inputPerMTokens).toBe(0.5)
  })
})

describe('PricingTable credit pricing', () => {
  it('kiro provider charges credit × $0.02 by default', () => {
    const table = new PricingTable()
    const cost = table.compute(
      'claude-sonnet-4-5',
      { inputTokens: 0, outputTokens: 0, credits: 2.5 },
      'kiro'
    )
    expect(cost.basis).toBe('credit')
    expect(cost.creditsUsd).toBeCloseTo(0.05, 6)
    expect(cost.totalUsd).toBeCloseTo(0.05, 6)
    expect(cost.inputUsd).toBe(0)
    expect(cost.outputUsd).toBe(0)
    expect(cost.known).toBe(true)
  })

  it('credit override replaces builtin price', () => {
    const table = new PricingTable({ creditOverrides: { kiro: 0.04 } })
    const cost = table.compute(undefined, { inputTokens: 0, outputTokens: 0, credits: 1 }, 'kiro')
    expect(cost.creditsUsd).toBeCloseTo(0.04, 6)
    expect(cost.basis).toBe('credit')
  })

  it('credit basis used even when model price unknown', () => {
    const table = new PricingTable()
    const cost = table.compute(
      'mystery-model-9000',
      { inputTokens: 100, outputTokens: 200, credits: 1.5 },
      'kiro'
    )
    expect(cost.basis).toBe('credit')
    expect(cost.creditsUsd).toBeCloseTo(0.03, 6)
  })

  it('falls back to token pricing when credits not set', () => {
    const table = new PricingTable()
    const cost = table.compute(
      'claude-sonnet-4-5',
      { inputTokens: 1_000_000, outputTokens: 0 },
      'kiro'
    )
    expect(cost.basis).toBe('token')
    expect(cost.totalUsd).toBeCloseTo(3, 5)
  })

  it('non-credit provider ignores credits field', () => {
    const table = new PricingTable()
    const cost = table.compute(
      'claude-sonnet-4-5',
      { inputTokens: 1_000_000, outputTokens: 0, credits: 5 },
      'codex' as any
    )
    expect(cost.basis).toBe('token')
    expect(cost.creditsUsd).toBe(0)
  })

  it('zero credits falls through to token pricing', () => {
    const table = new PricingTable()
    const cost = table.compute(
      'claude-sonnet-4-5',
      { inputTokens: 1_000_000, outputTokens: 0, credits: 0 },
      'kiro'
    )
    expect(cost.basis).toBe('token')
  })
})
