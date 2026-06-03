import type { AccountRuntimeState, ResponseKind } from '../types'

export const REQUEST_RACE_MIN_CONCURRENT = 2
export const REQUEST_RACE_MAX_CONCURRENT = 6
export const REQUEST_RACE_DEFAULT_CONCURRENT = 3

const LATENCY_EWMA_WEIGHT = 0.3
const SUCCESS_EWMA_WEIGHT = 0.25
const DEFAULT_SUCCESS_RATE = 0.75
const DEFAULT_LATENCY_MS = 8_000
const TIMEOUT_LATENCY_MS = 60_000

export function clampRequestRaceMaxConcurrent(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return REQUEST_RACE_DEFAULT_CONCURRENT
  return Math.max(REQUEST_RACE_MIN_CONCURRENT, Math.min(REQUEST_RACE_MAX_CONCURRENT, Math.trunc(n)))
}

export function normalizeRequestRaceSettings<T extends Record<string, any>>(settings: T): T {
  return {
    ...settings,
    requestRaceEnabled: settings.requestRaceEnabled === true,
    requestRaceMaxConcurrent: clampRequestRaceMaxConcurrent(settings.requestRaceMaxConcurrent)
  }
}

export function scoreAccountForRace(state: AccountRuntimeState): number {
  const raceStats = state.raceStats
  const successRate =
    raceStats?.successRateEwma ??
    (state.stats.totalRequests > 0
      ? state.stats.successfulRequests / Math.max(1, state.stats.totalRequests)
      : DEFAULT_SUCCESS_RATE)
  const latencyMs = raceStats?.ewmaLatencyMs ?? DEFAULT_LATENCY_MS
  const cooldownPenalty = state.cooldownUntil && state.cooldownUntil > Date.now() ? 200 : 0
  const failurePenalty = Math.min(100, state.failures * 12)
  return (
    successRate * 1_000 -
    Math.min(latencyMs, TIMEOUT_LATENCY_MS) / 100 -
    cooldownPenalty -
    failurePenalty
  )
}

export function recordAccountRaceSuccess(
  state: AccountRuntimeState,
  latencyMs: number | undefined
): void {
  const stats = ensureRaceStats(state)
  stats.attempts += 1
  stats.successes += 1
  stats.lastUpdatedAt = Date.now()
  if (Number.isFinite(latencyMs) && latencyMs !== undefined && latencyMs >= 0) {
    stats.ewmaLatencyMs =
      stats.ewmaLatencyMs === undefined
        ? latencyMs
        : stats.ewmaLatencyMs * (1 - LATENCY_EWMA_WEIGHT) + latencyMs * LATENCY_EWMA_WEIGHT
  }
  stats.successRateEwma =
    stats.successRateEwma === undefined
      ? 1
      : stats.successRateEwma * (1 - SUCCESS_EWMA_WEIGHT) + SUCCESS_EWMA_WEIGHT
}

export function recordAccountRaceFailure(
  state: AccountRuntimeState,
  kind: ResponseKind,
  latencyMs?: number
): void {
  const stats = ensureRaceStats(state)
  stats.attempts += 1
  stats.failures += 1
  stats.lastUpdatedAt = Date.now()
  if (kind === 'timeout') {
    stats.ewmaLatencyMs =
      stats.ewmaLatencyMs === undefined
        ? TIMEOUT_LATENCY_MS
        : stats.ewmaLatencyMs * (1 - LATENCY_EWMA_WEIGHT) + TIMEOUT_LATENCY_MS * LATENCY_EWMA_WEIGHT
  } else if (Number.isFinite(latencyMs) && latencyMs !== undefined && latencyMs >= 0) {
    stats.ewmaLatencyMs =
      stats.ewmaLatencyMs === undefined
        ? latencyMs
        : stats.ewmaLatencyMs * (1 - LATENCY_EWMA_WEIGHT) + latencyMs * LATENCY_EWMA_WEIGHT
  }
  stats.successRateEwma =
    stats.successRateEwma === undefined ? 0 : stats.successRateEwma * (1 - SUCCESS_EWMA_WEIGHT)
}

function ensureRaceStats(
  state: AccountRuntimeState
): NonNullable<AccountRuntimeState['raceStats']> {
  state.raceStats ??= {
    attempts: 0,
    successes: 0,
    failures: 0
  }
  return state.raceStats
}
