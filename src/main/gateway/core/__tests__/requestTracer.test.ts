import { describe, expect, it } from 'vitest'
import { wrapStreamForTracing, type RequestTrace } from '../requestTracer'

function makeTrace(): RequestTrace {
  return {
    requestId: 'req_test',
    method: 'POST',
    path: '/v1/chat/completions',
    model: 'test-model',
    apiFormat: 'openai',
    startedAt: Date.now()
  }
}

describe('requestTracer', () => {
  it('completes the trace when upstream next() throws', async () => {
    async function* failingStream(): AsyncGenerator<string> {
      yield 'first'
      throw new Error('boom')
    }

    let completed: RequestTrace | undefined
    const iterator = wrapStreamForTracing(failingStream(), makeTrace(), (trace) => {
      completed = { ...trace }
    })[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: 'first' })
    await expect(iterator.next()).rejects.toThrow('boom')
    expect(completed).toMatchObject({ chunkCount: 1 })
    expect(completed?.duration).toBeGreaterThanOrEqual(0)
  })

  it('completes the trace and closes upstream when the client returns early', async () => {
    let upstreamClosed = false
    async function* stream(): AsyncGenerator<string> {
      try {
        yield 'first'
        yield 'second'
      } finally {
        upstreamClosed = true
      }
    }

    let completed: RequestTrace | undefined
    const iterator = wrapStreamForTracing(stream(), makeTrace(), (trace) => {
      completed = { ...trace }
    })[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: 'first' })
    await iterator.return?.()
    expect(upstreamClosed).toBe(true)
    expect(completed).toMatchObject({ chunkCount: 1 })
  })
})
