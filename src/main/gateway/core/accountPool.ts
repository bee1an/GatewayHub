import type { AccountRuntimeState, AccountStatus, AccountTestResult, ResponseKind } from '../types'
import type { GatewayLogger } from './logger'
import { toErrorMessage } from './utils'
import {
  defaultAccountState as baseDefaultAccountState,
  isHardOffline as baseIsHardOffline,
  transitionStatus as baseTransitionStatus,
  type AccountWithState
} from './accountState'

/**
 * Shared runtime shape used by every per-provider pool. Re-exported for
 * provider-local convenience; mirrors the `XxxAccountRuntime` interfaces
 * that each pool already declares.
 */
export type { AccountWithState }

/**
 * Classified upstream error used by reportFailure() to drive status transitions.
 * Every provider already declares an isomorphic `XxxClassifiedError` type.
 */
export interface ClassifiedError {
  kind: ResponseKind
  cooldownMs: number
  resetAtIso?: string
}

/**
 * Base class for per-provider account pools.
 *
 * Absorbs the ~250 lines of identical boilerplate that was copied across all 9
 * pool files: reload(), listAccounts(), listModels(), resetAccount(),
 * setAccountStatus(), reportSuccess(), reportFailure(), transitionStatus(),
 * isAvailable(), and the two-pass getAccountForModel() rotation loop.
 *
 * Providers override only the hooks where they genuinely differ:
 *  - {@link seedModels}: initial modelIds for a fresh account (kiro/codex/grokWeb/qoder pre-seed fallbacks)
 *  - {@link isHardOffline}: qoder does NOT treat quota_exceeded as hard-offline
 *  - {@link accountHasModel} / {@link normalizeModel}: model-id comparison
 *  - {@link redactSecrets}: which config fields to mask in listAccounts()
 *  - {@link providerName}: log category
 *
 * The HTTP-specific methods (testAccount, getAccountInfo, refreshAccountModels,
 * maybeRefreshAccountModels) stay provider-specific — they vary too much to share.
 */
export abstract class BaseAccountPool<C extends { id: string; enabled: boolean; label?: string }> {
  protected accounts: AccountWithState<C>[] = []
  protected currentAccountIndex = 0

  constructor(
    protected readonly logger: GatewayLogger,
    protected readonly onStateChanged: () => void
  ) {}

  // --- hooks providers must implement ---

  /** Log/telemetry category, e.g. 'nvidia', 'openrouter'. */
  protected abstract providerName: string
  /** Whether an account's cached model list includes `model` (already normalized). */
  protected abstract accountHasModel(account: AccountWithState<C>, model: string): boolean
  /** Normalize a model id for comparison (trim, lowercase, etc.). */
  protected abstract normalizeModel(model: string): string
  /** Return a redacted copy of the config for listAccounts(). */
  protected abstract redactSecrets(config: C): C

  // --- overridable hooks with sensible defaults ---

  /** Initial modelIds for a fresh account. Default: empty. */
  protected seedModels(): string[] {
    return []
  }

  /** Whether a status blocks an account from recovery. Default includes quota_exceeded; qoder overrides. */
  protected isHardOffline(status: AccountStatus): boolean {
    return baseIsHardOffline(status)
  }

  /** Availability probe with 10% early-retry chance. Default matches the 6 async pools. */
  protected isAvailable(account: AccountWithState<C>, now: number): boolean {
    const status = account.state.status
    if (status === 'available') return true
    if (this.isHardOffline(status)) return false
    if (account.state.cooldownUntil && now > account.state.cooldownUntil) return true
    return Math.random() < 0.1
  }

  // --- shared state helpers ---

  protected defaultAccountState(): AccountRuntimeState {
    return { ...baseDefaultAccountState(), modelIds: this.seedModels() }
  }

  protected transitionStatus(
    account: AccountWithState<C>,
    status: AccountStatus,
    reason?: string,
    cooldownUntil?: number
  ): void {
    baseTransitionStatus(account, status, reason, cooldownUntil)
  }

  protected accountLabel(account: AccountWithState<C>): string {
    return account.config.label || account.config.id
  }

  // --- shared public surface (verbatim from the 9 pools) ---

  async reload(accountFiles: C[]): Promise<void> {
    this.accounts = accountFiles.map((account) => {
      const state = this.lookupState(account.id) ?? this.defaultAccountState()
      state.status ??= 'available'
      state.statusUpdatedAt ??= 0
      this.storeState(account.id, state)
      return { config: account, state }
    })
    const active = new Set(accountFiles.map((a) => a.id))
    for (const id of this.stateIds()) {
      if (!active.has(id)) this.deleteState(id)
    }
    this.onStateChanged()
  }

  async dispose(): Promise<void> {
    this.accounts = []
  }

  listAccounts(): AccountWithState<C>[] {
    return this.accounts.map((runtime) => ({
      ...runtime,
      config: this.redactSecrets(runtime.config)
    }))
  }

  listModels(): string[] {
    const set = new Set<string>()
    for (const account of this.accounts) {
      if (account.config.enabled === false) continue
      for (const model of account.state.modelIds || []) set.add(model)
    }
    return [...set].sort()
  }

  async resetAccount(accountId: string): Promise<void> {
    const account = this.accounts.find((a) => a.config.id === accountId)
    if (!account) return
    account.state.failures = 0
    account.state.lastError = undefined
    account.state.lastFailureAt = 0
    account.state.lastResponseKind = undefined
    this.transitionStatus(account, 'available', undefined)
    this.onStateChanged()
  }

  async setAccountStatus(accountId: string, status: AccountStatus, reason?: string): Promise<void> {
    const account = this.accounts.find((a) => a.config.id === accountId)
    if (!account) throw new Error(`Account not found: ${accountId}`)
    if (status === 'available') {
      account.state.failures = 0
      account.state.lastError = undefined
      account.state.cooldownUntil = undefined
    }
    this.transitionStatus(account, status, reason)
    this.onStateChanged()
  }

  /**
   * Two-pass round-robin account selection. Pass 1: prefer available accounts;
   * pass 2: relax to "skip only hard-offline". Shared verbatim by the 6 async pools.
   *
   * Candidate evaluation order is availability → onCandidate (e.g. refresh) →
   * model check, and the selected index is committed as-is (next rotation starts
   * from the just-selected account). This matches the openrouter/nvidia pools.
   * Pools with a different ordering (auth-gated, model-first, or idx+1 semantics)
   * should call {@link pickAccountTwoPassGeneric} directly instead.
   */
  protected async pickAccountTwoPass(
    model: string,
    exclude: Set<string>,
    onCandidate: (account: AccountWithState<C>) => Promise<void>
  ): Promise<AccountWithState<C> | undefined> {
    const normalizedModel = this.normalizeModel(model)
    return this.pickAccountTwoPassGeneric(exclude, async (account, relax) => {
      if (relax) {
        if (this.isHardOffline(account.state.status)) return false
      } else if (!this.isAvailable(account, Date.now())) {
        return false
      }
      await onCandidate(account)
      return this.accountHasModel(account, normalizedModel)
    })
  }

  /**
   * Fully pluggable two-pass round-robin loop. `evaluate` returns:
   *  - `true`  → select this account and return it
   *  - `false` → skip (failed a per-pass check)
   * The pass-1/pass-2 distinction is the caller's responsibility inside
   * `evaluate` via the `relaxAvailability` flag. Index commit semantics are
   * controlled by {@link commitIndex} (default: store the selected idx).
   *
   * This lets auth-gated pools (codex/kiro/windsurf/trae/qoder) plug in their
   * own candidate ordering (model→availability→auth, availability→model→auth, …)
   * and their own idx vs idx+1 convention without forking the loop body.
   */
  protected async pickAccountTwoPassGeneric(
    exclude: Set<string>,
    evaluate: (account: AccountWithState<C>, relaxAvailability: boolean) => Promise<boolean>
  ): Promise<AccountWithState<C> | undefined> {
    if (!this.accounts.length) return undefined
    const start = this.currentAccountIndex % this.accounts.length
    const tryPass = async (
      relaxAvailability: boolean
    ): Promise<AccountWithState<C> | undefined> => {
      for (let i = 0; i < this.accounts.length; i++) {
        const idx = (start + i) % this.accounts.length
        const account = this.accounts[idx]
        if (account.config.enabled === false || exclude.has(account.config.id)) continue
        if (!(await evaluate(account, relaxAvailability))) continue
        this.currentAccountIndex = idx
        this.commitIndex(idx)
        this.onStateChanged()
        return account
      }
      return undefined
    }
    return (await tryPass(false)) ?? (await tryPass(true))
  }

  /**
   * Synchronous sibling of {@link pickAccountTwoPassGeneric} for pools whose
   * candidate evaluation needs no async work (gptWeb / qoder). Identical two-pass
   * structure and {@link commitIndex} semantics; the only difference is that
   * `evaluate` returns a plain boolean.
   */
  protected pickAccountTwoPassSync(
    exclude: Set<string>,
    evaluate: (account: AccountWithState<C>, relaxAvailability: boolean) => boolean
  ): AccountWithState<C> | undefined {
    if (!this.accounts.length) return undefined
    const start = this.currentAccountIndex % this.accounts.length
    const tryPass = (relaxAvailability: boolean): AccountWithState<C> | undefined => {
      for (let i = 0; i < this.accounts.length; i++) {
        const idx = (start + i) % this.accounts.length
        const account = this.accounts[idx]
        if (account.config.enabled === false || exclude.has(account.config.id)) continue
        if (!evaluate(account, relaxAvailability)) continue
        this.currentAccountIndex = idx
        this.commitIndex(idx)
        this.onStateChanged()
        return account
      }
      return undefined
    }
    return tryPass(false) ?? tryPass(true)
  }

  /**
   * How the round-robin index is persisted after a selection.
   * Default: store the selected idx (next rotation resumes here). Pools that
   * historically stored `idx + 1` (gptWeb/grokWeb/qoder) override to advance.
   */
  protected commitIndex(idx: number): void {
    this.setCurrentIndex(idx)
  }

  /**
   * Shared success-reporting body. Pools that support request-racing should
   * override to additionally call recordAccountRaceSuccess().
   */
  async reportSuccess(account: AccountWithState<C>, _latencyMs?: number): Promise<void> {
    account.state.failures = 0
    account.state.lastError = undefined
    account.state.lastSuccessAt = Date.now()
    account.state.stats.totalRequests += 1
    account.state.stats.successfulRequests += 1
    account.state.lastResponseKind = 'success'
    this.transitionStatus(account, 'available', undefined)
    this.onStateChanged()
  }

  /**
   * Shared failure-reporting body with the standard status-mapping branch table.
   * Pools that support request-racing should override to additionally call
   * recordAccountRaceFailure().
   *
   * The status→cooldownUntil mapping is delegated to {@link resolveCooldown} so
   * pools that diverge from the default (codex's resetAtIso, qoder's capped
   * backoff, gptWeb's flat cooldown) can override just that one hook instead of
   * forking the whole counter/log preamble.
   */
  async reportFailure(
    account: AccountWithState<C>,
    error: unknown,
    classified: ClassifiedError
  ): Promise<void> {
    account.state.failures += 1
    account.state.lastFailureAt = Date.now()
    account.state.lastError = toErrorMessage(error)
    account.state.stats.totalRequests += 1
    account.state.stats.failedRequests += 1
    account.state.lastResponseKind = classified.kind
    const now = Date.now()
    const reason = account.state.lastError.slice(0, 200)
    const { status, cooldownUntil } = this.resolveCooldown(account, classified, now)
    this.transitionStatus(account, status, reason, cooldownUntil)
    this.logger.warn(account.state.lastError, {
      provider: this.providerName,
      accountId: this.accountLabel(account),
      category: 'account'
    })
    this.onStateChanged()
  }

  /**
   * Map a classified upstream error to the next account status + cooldown
   * deadline. Default implementation:
   *  - auth → auth_failed, no cooldown
   *  - quota → quota_exceeded, cooldown = now + classified.cooldownMs
   *  - rate_limit → rate_limited, cooldown = now + classified.cooldownMs
   *  - anything else → cooling with exponential backoff (cap 64×, base cooldownMs)
   * Override to change the mapping without re-implementing the counter/log body.
   */
  protected resolveCooldown(
    account: AccountWithState<C>,
    classified: ClassifiedError,
    now: number
  ): { status: AccountStatus; cooldownUntil?: number } {
    if (classified.kind === 'auth') return { status: 'auth_failed' }
    if (classified.kind === 'quota')
      return { status: 'quota_exceeded', cooldownUntil: now + classified.cooldownMs }
    if (classified.kind === 'rate_limit')
      return { status: 'rate_limited', cooldownUntil: now + classified.cooldownMs }
    const multiplier = Math.min(64, Math.pow(2, Math.max(0, account.state.failures - 1)))
    return { status: 'cooling', cooldownUntil: now + classified.cooldownMs * multiplier }
  }

  // --- state-store access: providers wire these to their XxxProviderState ---

  /** Subclasses must expose the runtime state for an account id (or undefined). */
  protected lookupState(_accountId: string): AccountRuntimeState | undefined {
    return undefined
  }
  /** Subclasses must persist a runtime state for an account id. */
  protected storeState(_accountId: string, _state: AccountRuntimeState): void {
    /* default no-op */
  }
  /** Subclasses must delete the runtime state for a removed account id. */
  protected deleteState(_accountId: string): void {
    /* default no-op */
  }
  /** Subclasses must expose all stored account ids (for reload pruning). */
  protected stateIds(): string[] {
    return []
  }
  /** Subclasses must persist the round-robin index (for restart continuity). */
  protected setCurrentIndex(index: number): void {
    void index
  }
}

export type { AccountTestResult }
