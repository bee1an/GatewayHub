import type { CostStats, GatewayLogEntry, ProviderName, UsageStats } from '../types'

export interface RequestTrace {
  requestId: string
  method: string
  path: string
  model?: string
  apiFormat?: 'openai' | 'anthropic'
  startedAt: number
  streaming?: boolean
  statusCode?: number
  duration?: number
  timeToFirstToken?: number
  chunkCount?: number
  usage?: UsageStats
  cost?: CostStats
  accountId?: string
  /** 来源网关；onUsage 回调里写入，决定 cost 计价方式 */
  provider?: ProviderName
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
      let completed = false

      const finalize = (): void => {
        if (completed) return
        completed = true
        trace.chunkCount = chunks
        trace.duration = Date.now() - trace.startedAt
        try {
          onComplete(trace)
        } catch (err) {
          console.warn('[requestTracer] onComplete failed', err)
        }
      }

      return {
        async next() {
          if (completed) return { done: true, value: undefined }
          try {
            const result = await iterator.next()
            if (result.done) {
              finalize()
              return result
            }
            chunks++
            if (firstChunk) {
              firstChunk = false
              trace.timeToFirstToken = Date.now() - trace.startedAt
            }
            return result
          } catch (err) {
            finalize()
            throw err
          }
        },
        async return(value?: any) {
          finalize()
          return iterator.return?.(value) ?? { done: true, value: undefined }
        },
        async throw(err?: any) {
          finalize()
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
