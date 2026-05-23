import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PricingTable } from '../pricing'
import { UsageStore } from '../usageStore'

describe('UsageStore', () => {
  let dir: string
  let storePath: string
  const pricing = new PricingTable()

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gatewayhub-usage-store-'))
    storePath = join(dir, 'usage-store/v1.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('records and reads back today usage with cost', async () => {
    const fixedNow = new Date('2026-05-23T10:00:00')
    const store = new UsageStore({ filePath: storePath, pricing, now: () => fixedNow })

    await store.record({
      accountId: 'acc-1',
      model: 'claude-sonnet-4-5',
      apiFormat: 'anthropic',
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadTokens: 200_000
      }
    })

    const detail = await store.read()
    expect(detail.daily).toHaveLength(1)
    expect(detail.daily[0]).toMatchObject({
      date: '2026-05-23',
      accountId: 'acc-1',
      model: 'claude-sonnet-4-5',
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 200_000,
      requests: 1
    })
    // 1M*$3 + 500k*$15 + 200k*$0.30 = 3 + 7.5 + 0.06
    expect(detail.daily[0].costUsd).toBeCloseTo(10.56, 2)
    expect(detail.summary.todayTokens).toBe(1_700_000)
    expect(detail.summary.todayCostUsd).toBeCloseTo(10.56, 2)
    expect(detail.summary.todayRequests).toBe(1)
  })

  it('accumulates multiple records to the same account/model/day', async () => {
    const fixedNow = new Date('2026-05-23T12:00:00')
    const store = new UsageStore({ filePath: storePath, pricing, now: () => fixedNow })

    await store.record({
      accountId: 'acc-1',
      model: 'claude-haiku-4-5',
      usage: { inputTokens: 1_000, outputTokens: 500 }
    })
    await store.record({
      accountId: 'acc-1',
      model: 'claude-haiku-4-5',
      usage: { inputTokens: 2_000, outputTokens: 1_000 }
    })

    const detail = await store.read()
    expect(detail.daily).toHaveLength(1)
    expect(detail.daily[0]).toMatchObject({
      inputTokens: 3_000,
      outputTokens: 1_500,
      requests: 2
    })
  })

  it('returns null cost when model is unknown to pricing table', async () => {
    const fixedNow = new Date('2026-05-23T12:00:00')
    const store = new UsageStore({ filePath: storePath, pricing, now: () => fixedNow })

    await store.record({
      accountId: 'acc-1',
      model: 'mystery-model-9000',
      usage: { inputTokens: 100, outputTokens: 50 }
    })

    const detail = await store.read()
    expect(detail.daily[0].costUsd).toBeNull()
    expect(detail.summary.todayCostUsd).toBeNull()
  })

  it('strips provider prefix and normalizes case for model key', async () => {
    const fixedNow = new Date('2026-05-23T12:00:00')
    const store = new UsageStore({ filePath: storePath, pricing, now: () => fixedNow })

    await store.record({
      accountId: 'acc-1',
      model: 'KIRO/Claude-Sonnet-4-5-20250920',
      usage: { inputTokens: 1_000, outputTokens: 500 }
    })

    const detail = await store.read()
    expect(detail.daily[0].model).toBe('claude-sonnet-4-5-20250920')
    // pricing.compute 走前缀回退能命中 claude-sonnet-4-5
    expect(detail.daily[0].costUsd).not.toBeNull()
  })

  it('prunes entries older than 30 days on write', async () => {
    const oldDay = new Date('2026-04-01T12:00:00')
    const today = new Date('2026-05-23T12:00:00')

    const oldStore = new UsageStore({ filePath: storePath, pricing, now: () => oldDay })
    await oldStore.record({
      accountId: 'acc-1',
      model: 'claude-haiku-4-5',
      usage: { inputTokens: 1_000, outputTokens: 500 }
    })

    const todayStore = new UsageStore({ filePath: storePath, pricing, now: () => today })
    await todayStore.record({
      accountId: 'acc-1',
      model: 'claude-haiku-4-5',
      usage: { inputTokens: 2_000, outputTokens: 1_000 }
    })

    const detail = await todayStore.read()
    expect(detail.daily).toHaveLength(1)
    expect(detail.daily[0].date).toBe('2026-05-23')
  })

  it('clear empties the store on disk', async () => {
    const fixedNow = new Date('2026-05-23T12:00:00')
    const store = new UsageStore({ filePath: storePath, pricing, now: () => fixedNow })
    await store.record({
      accountId: 'acc-1',
      model: 'claude-haiku-4-5',
      usage: { inputTokens: 1_000, outputTokens: 500 }
    })
    await store.clear()

    const detail = await store.read()
    expect(detail.daily).toHaveLength(0)
    expect(detail.summary.todayTokens).toBe(0)
  })
})
