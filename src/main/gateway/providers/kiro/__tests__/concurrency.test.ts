import { describe, expect, it } from 'vitest'
import { DEFAULT_KIRO_SETTINGS, normalizeKiroSettings } from '../constants'
import { KiroRequestLimiter, isLargeKiroRequestBody } from '../concurrency'

describe('kiro/concurrency', () => {
  it('defaults first-token timeout to 60s and clamps concurrency settings', () => {
    expect(DEFAULT_KIRO_SETTINGS.firstTokenTimeoutSeconds).toBe(60)
    const settings = normalizeKiroSettings({
      firstTokenTimeoutSeconds: 0,
      maxConcurrentRequests: 2.9,
      maxConcurrentLargePromptRequests: 99,
      largePromptBytes: 1
    } as any)

    expect(settings.firstTokenTimeoutSeconds).toBe(1)
    expect(settings.maxConcurrentRequests).toBe(2)
    expect(settings.maxConcurrentLargePromptRequests).toBe(2)
    expect(settings.largePromptBytes).toBe(32_000)
  })

  it('detects large prompts by serialized request byte length', () => {
    expect(isLargeKiroRequestBody({ messages: [{ content: 'x'.repeat(20) }] }, 10)).toBe(true)
    expect(isLargeKiroRequestBody({ messages: [{ content: 'x' }] }, 10_000)).toBe(false)
  })

  it('serializes large prompts while allowing small prompts up to total concurrency', async () => {
    const limiter = new KiroRequestLimiter(
      normalizeKiroSettings({
        maxConcurrentRequests: 2,
        maxConcurrentLargePromptRequests: 1,
        largePromptBytes: 32_000
      })
    )

    const large = { messages: [{ content: 'x'.repeat(40_000) }] }
    const small = { messages: [{ content: 'small' }] }

    const releaseLarge1 = await limiter.acquire(large)
    let large2Acquired = false
    const large2 = limiter.acquire(large).then((release) => {
      large2Acquired = true
      return release
    })
    await Promise.resolve()
    expect(large2Acquired).toBe(false)

    const releaseSmall = await limiter.acquire(small)
    expect(large2Acquired).toBe(false)

    releaseLarge1()
    const releaseLarge2 = await large2
    expect(large2Acquired).toBe(true)

    releaseSmall()
    releaseLarge2()
  })
})
