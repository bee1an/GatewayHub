import type { KiroProviderSettings } from '../../types'

export class KiroRequestLimiter {
  private readonly allRequests: Semaphore
  private readonly largeRequests: Semaphore

  constructor(private readonly settings: KiroProviderSettings) {
    this.allRequests = new Semaphore(Math.max(1, settings.maxConcurrentRequests || 4))
    this.largeRequests = new Semaphore(Math.max(1, settings.maxConcurrentLargePromptRequests || 1))
  }

  async acquire(body: unknown): Promise<() => void> {
    const releaseLarge = isLargeKiroRequestBody(body, this.settings.largePromptBytes)
      ? await this.largeRequests.acquire()
      : undefined
    const releaseAll = await this.allRequests.acquire()
    let released = false
    return () => {
      if (released) return
      released = true
      releaseAll()
      releaseLarge?.()
    }
  }
}

export function isLargeKiroRequestBody(body: unknown, thresholdBytes: number): boolean {
  const threshold = Math.max(1, Math.trunc(thresholdBytes || 300_000))
  return Buffer.byteLength(safeStringify(body), 'utf8') >= threshold
}

class Semaphore {
  private active = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1
    } else {
      await new Promise<void>((resolve) =>
        this.queue.push(() => {
          this.active += 1
          resolve()
        })
      )
    }
    let released = false
    return () => {
      if (released) return
      released = true
      this.active = Math.max(0, this.active - 1)
      this.queue.shift()?.()
    }
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) || ''
  } catch {
    return String(value ?? '')
  }
}
