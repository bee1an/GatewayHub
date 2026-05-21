import type { GatewayLogEntry } from '../types'

export interface RequestTrace {
  requestId: string
  method: string
  path: string
  model?: string
  startedAt: number
  streaming?: boolean
  statusCode?: number
  duration?: number
  timeToFirstToken?: number
  chunkCount?: number
}

export function wrapStreamForTracing(
  stream: AsyncIterable<string | Uint8Array>,
  trace: RequestTrace,
  onComplete: (trace: RequestTrace) => void
): AsyncIterable<string | Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = stream[Symbol.asyncIterator]()
      let firstChunk = true
      let chunks = 0

      return {
        async next() {
          const result = await iterator.next()
          if (result.done) {
            trace.chunkCount = chunks
            trace.duration = Date.now() - trace.startedAt
            onComplete(trace)
            return result
          }
          chunks++
          if (firstChunk) {
            firstChunk = false
            trace.timeToFirstToken = Date.now() - trace.startedAt
          }
          return result
        },
        async return(value?: any) {
          trace.chunkCount = chunks
          trace.duration = Date.now() - trace.startedAt
          onComplete(trace)
          return iterator.return?.(value) ?? { done: true, value: undefined }
        },
        async throw(err?: any) {
          trace.chunkCount = chunks
          trace.duration = Date.now() - trace.startedAt
          onComplete(trace)
          return iterator.throw?.(err) ?? { done: true, value: undefined }
        }
      }
    }
  }
}

export function traceToLogMeta(trace: RequestTrace): Partial<GatewayLogEntry> {
  return {
    requestId: trace.requestId,
    category: 'request',
    statusCode: trace.statusCode,
    duration: trace.duration,
    streaming: trace.streaming,
    timeToFirstToken: trace.timeToFirstToken,
    chunkCount: trace.chunkCount
  }
}
