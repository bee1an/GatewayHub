import type { AccountRuntimeState, AccountStatus } from '../types'

/**
 * Shared account-runtime helpers extracted from the 9 per-provider account pools.
 *
 * These were previously duplicated verbatim in every pool file. They are pure and
 * stateless, so a single module-level copy covers all providers.
 */

export function defaultAccountState(): AccountRuntimeState {
  return {
    failures: 0,
    lastFailureAt: 0,
    lastSuccessAt: 0,
    modelsCachedAt: 0,
    modelIds: [],
    status: 'available',
    statusUpdatedAt: 0,
    stats: { totalRequests: 0, successfulRequests: 0, failedRequests: 0 }
  }
}

/**
 * Statuses from which an account cannot recover automatically — they require
 * re-auth, a quota reset, or manual re-enablement. Used by the two-pass rotation
 * loop and by isAvailable().
 *
 * Note: qoder's pool historically excluded `quota_exceeded` here; it overrides
 * isAvailable() locally, so this shared definition does not affect it.
 */
export function isHardOffline(status: AccountStatus): boolean {
  return status === 'auth_failed' || status === 'manual_disabled' || status === 'quota_exceeded'
}

export interface AccountWithState<C> {
  config: C
  state: AccountRuntimeState
}

/**
 * Mutates the account's state to reflect a status transition.
 * Extracted verbatim from the private transitionStatus() in all 9 pools.
 */
export function transitionStatus<C>(
  account: AccountWithState<C>,
  status: AccountStatus,
  reason?: string,
  cooldownUntil?: number
): void {
  account.state.status = status
  account.state.statusReason = reason
  account.state.statusUpdatedAt = Date.now()
  account.state.cooldownUntil = cooldownUntil
}

/**
 * Probabilistic availability check shared by the rotation loop.
 * - available: always usable
 * - hard-offline (auth/quota/manual): never usable
 * - past cooldown: usable again
 * - otherwise (cooling/rate_limited): 10% probe chance to re-test early
 */
export function isAvailable<C>(account: AccountWithState<C>, now: number): boolean {
  const status = account.state.status
  if (status === 'available') return true
  if (isHardOffline(status)) return false
  if (account.state.cooldownUntil && now > account.state.cooldownUntil) return true
  return Math.random() < 0.1
}
