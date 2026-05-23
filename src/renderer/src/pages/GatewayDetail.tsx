import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { usePolling } from '../hooks/usePolling'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { TabGroup } from '../components/ui/TabGroup'
import { ConfirmDialog } from '../components/ui/ConfirmDialog'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { TooltipWrapper } from '../components/ui/Tooltip'
import { useToast } from '../components/ui/ToastContext'
import Usage from './Usage'

type AccountFilter = 'all' | 'available' | 'problematic'

type Provider = {
  name: string
  providerType: string
  enabled: boolean
  configured: boolean
  status: string
  message?: string
  models: string[]
  accounts?: Account[]
}

type AccountStatus =
  | 'available'
  | 'cooling'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'auth_failed'
  | 'manual_disabled'

type Account = {
  id: string
  label?: string
  type: string
  enabled: boolean
  path?: string
  failures: number
  lastError?: string
  lastSuccessAt?: number
  lastFailureAt?: number
  models?: string[]
  stats?: { totalRequests: number; successfulRequests: number; failedRequests: number }
  authType?: string
  expiresAt?: string
  status?: AccountStatus
  statusReason?: string
  statusUpdatedAt?: number
  cooldownUntil?: number
  lastResponseKind?: string
}

type AccountInfo = {
  subscription: { title: string; type: string }
  email?: string
  usage: {
    used: number
    limit: number
    overages: number
    overageCap: number
    overageRate: number
    overageCharges: number
    resetDate: string
  }
  models: Array<{ modelId: string; modelName: string; rateMultiplier: number; rateUnit: string }>
  error?: string
}

type GatewayStatus = {
  server: { running: boolean; url: string; host: string; port: number; apiKeys: any[] }
  configPath: string
  statePath: string
  providers: Provider[]
  logs: any[]
}

const accountInfoCache: Record<string, { data?: AccountInfo; loading: boolean; error?: string }> =
  {}

function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])

  return now
}

export default function GatewayDetail(): React.JSX.Element {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { name } = useParams<{ name: string }>()
  const { data: status, refresh } = usePolling<GatewayStatus>(
    () => window.api.gateway.status(),
    3000
  )
  const [busy, setBusy] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [accountInfoMap, setAccountInfoMap] = useState(accountInfoCache)
  const [routeNameDraft, setRouteNameDraft] = useState<{ name: string; value: string } | null>(null)
  const [editingRouteName, setEditingRouteName] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<{ id: string; label: string } | null>(null)
  const [filter, setFilter] = useState<AccountFilter>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [tab, setTab] = useState<'overview' | 'usage'>('overview')

  const draftValue =
    routeNameDraft && routeNameDraft.name === name ? routeNameDraft.value : (name ?? '')

  const gateway = useMemo(() => status?.providers.find((p) => p.name === name), [status, name])
  const accounts = useMemo<Account[]>(() => gateway?.accounts ?? [], [gateway?.accounts])
  const isKiro = gateway?.providerType === 'kiro'
  const accountIdsKey = useMemo(() => accounts.map((a) => a.id).join(','), [accounts])

  const filteredAccounts = useMemo(() => {
    let list = accounts
    if (filter === 'available') {
      list = list.filter((a) => a.enabled && (a.status === 'available' || !a.status))
    } else if (filter === 'problematic') {
      list = list.filter(
        (a) =>
          !a.enabled || (a.status && a.status !== 'available' && a.status !== 'manual_disabled')
      )
    }
    return list
  }, [accounts, filter])

  const accountStats = useMemo(() => {
    const healthy = accounts.filter(
      (a) => a.enabled && (a.status === 'available' || !a.status)
    ).length
    const problematic = accounts.filter(
      (a) => a.enabled && a.status && a.status !== 'available' && a.status !== 'manual_disabled'
    ).length
    const totalReqs = accounts.reduce((s, a) => s + (a.stats?.totalRequests ?? 0), 0)
    return { healthy, problematic, totalReqs, total: accounts.length }
  }, [accounts])

  const fetchAccountInfo = useCallback(async (accountId: string) => {
    setAccountInfoMap((prev) => ({ ...prev, [accountId]: { ...prev[accountId], loading: true } }))
    try {
      const info = await window.api.gateway.getAccountInfo(accountId)
      setAccountInfoMap((prev) => {
        const next = { ...prev, [accountId]: { data: info, loading: false } }
        accountInfoCache[accountId] = next[accountId]
        return next
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setAccountInfoMap((prev) => ({
        ...prev,
        [accountId]: { ...prev[accountId], loading: false, error: message }
      }))
    }
  }, [])

  const fetchAllUsage = useCallback(() => {
    accounts.filter((a) => a.enabled).forEach((acc) => fetchAccountInfo(acc.id))
  }, [accounts, fetchAccountInfo])

  useEffect(() => {
    if (!isKiro) return
    accounts
      .filter((a) => a.enabled && !accountInfoMap[a.id])
      .forEach((acc) => fetchAccountInfo(acc.id))
  }, [accountIdsKey, accountInfoMap, accounts, fetchAccountInfo, isKiro])

  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined)
  useEffect(() => {
    if (!isKiro || !accounts.length) return
    pollRef.current = setInterval(fetchAllUsage, 5 * 60_000)
    return () => clearInterval(pollRef.current)
  }, [accounts.length, fetchAllUsage, isKiro])

  async function run(action: () => Promise<any>, success: string): Promise<void> {
    setBusy(true)
    try {
      await action()
      await refresh()
      toast(success, 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  if (!gateway) {
    return (
      <div className="space-y-5 animate-fade-in">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-[20px] w-[100px] rounded bg-charcoal/80 animate-pulse" />
            <div className="h-[18px] w-[50px] rounded bg-charcoal/50 animate-pulse" />
          </div>
          <div className="h-[30px] w-[90px] rounded bg-charcoal/60 animate-pulse" />
        </div>
        <div className="grid grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="card px-3 py-2.5 flex flex-col gap-2">
              <div className="h-[12px] w-[60px] rounded bg-charcoal/60 animate-pulse" />
              <div className="h-[18px] w-[36px] rounded bg-charcoal/80 animate-pulse" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="card px-2.5 py-2 flex flex-col gap-2 border-l-[2.5px] border-l-charcoal"
            >
              <div className="flex items-center gap-2">
                <div className="w-[6px] h-[6px] rounded-full bg-charcoal" />
                <div className="h-[14px] w-[120px] rounded bg-charcoal/70 animate-pulse" />
              </div>
              <div className="h-[4px] w-full rounded-full bg-charcoal/40 animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center gap-2">
        <h1 className="text-[17px] font-[590] text-porcelain capitalize tracking-[-0.15px]">
          {name}
        </h1>
        {editingRouteName ? (
          <form
            className="flex items-center gap-1.5"
            onSubmit={async (e) => {
              e.preventDefault()
              const val = draftValue
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9_-]/g, '')
              if (val && val !== name && gateway?.providerType) {
                await run(
                  () => window.api.gateway.updateProviderRouteName(gateway.providerType, val),
                  t('settings.saved')
                )
                window.location.hash = `#/gateway/${val}`
              }
              setEditingRouteName(false)
            }}
          >
            <input
              autoFocus
              value={draftValue}
              onChange={(e) => setRouteNameDraft({ name: name ?? '', value: e.target.value })}
              onBlur={() => setEditingRouteName(false)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditingRouteName(false)
              }}
              placeholder={name}
              autoComplete="off"
              aria-label={t('gateway.editRouteName')}
              className="input-base font-mono !py-0.5 !px-1.5 !text-[12px] w-28"
            />
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={
                busy ||
                !draftValue.trim() ||
                draftValue.trim().toLowerCase() === (name || '').toLowerCase()
              }
              onMouseDown={(e) => e.preventDefault()}
            >
              {t('settings.save')}
            </Button>
          </form>
        ) : (
          <TooltipWrapper content={t('gateway.editRouteName')}>
            <button
              type="button"
              onClick={() => {
                setRouteNameDraft({ name: name ?? '', value: name ?? '' })
                setEditingRouteName(true)
              }}
              className="inline-flex items-center justify-center w-6 h-6 rounded-[var(--radius-sm)] text-fog hover:text-storm hover:bg-[color-mix(in_srgb,var(--c-charcoal)_60%,transparent)] transition-colors"
              aria-label={t('gateway.editRouteName')}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M4 20h4l10-10-4-4L4 16v4z"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
                <path d="M14 6l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </TooltipWrapper>
        )}
      </div>

      {accounts.length === 0 ? (
        <div className="card px-4 py-10 flex flex-col items-center gap-2">
          <span className="i-ph-users-three text-[28px] text-charcoal" aria-hidden="true" />
          <span className="text-fog text-[13px]">{t('gateway.noAccounts')}</span>
        </div>
      ) : (
        <>
          <SegmentedControl
            value={tab}
            onValueChange={(v) => setTab(v as 'overview' | 'usage')}
            items={[
              { value: 'overview', label: t('gateway.tabOverview') },
              { value: 'usage', label: t('gateway.tabUsage') }
            ]}
          />

          {tab === 'usage' && gateway?.providerType ? (
            <Usage
              provider={gateway.providerType}
              hideHeader
              accountLabels={Object.fromEntries(
                accounts.map((a) => [a.id, accountInfoMap[a.id]?.data?.email || a.label || a.id])
              )}
            />
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3">
                <div className="card px-3 py-2 flex flex-col gap-1">
                  <span className="text-[10px] text-storm font-medium uppercase tracking-[0.5px]">
                    {t('gateway.healthy')}
                  </span>
                  <span className="text-[17px] font-[650] text-emerald tabular-nums leading-none">
                    {accountStats.healthy}{' '}
                    <span className="text-[12px] text-fog font-normal">/ {accountStats.total}</span>
                  </span>
                </div>
                <div className="card px-3 py-2 flex flex-col gap-1">
                  <span className="text-[10px] text-storm font-medium uppercase tracking-[0.5px]">
                    {t('gateway.requests')}
                  </span>
                  <span className="text-[17px] font-[650] text-porcelain tabular-nums leading-none">
                    {accountStats.totalReqs}
                  </span>
                </div>
                <div className="card px-3 py-2 flex flex-col gap-1">
                  <span className="text-[10px] text-storm font-medium uppercase tracking-[0.5px]">
                    {t('gateway.successRate')}
                  </span>
                  <span
                    className={`text-[17px] font-[650] tabular-nums leading-none ${accountStats.problematic > 0 ? 'text-warning' : 'text-emerald'}`}
                  >
                    {accountStats.totalReqs > 0
                      ? `${Math.round((accounts.reduce((s, a) => s + (a.stats?.successfulRequests ?? 0), 0) / accountStats.totalReqs) * 100)}%`
                      : '100%'}
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <SegmentedControl
                  value={filter}
                  onValueChange={(v) => setFilter(v as AccountFilter)}
                  items={[
                    { value: 'all', label: `${t('logs.all')} (${accounts.length})` },
                    {
                      value: 'available',
                      label: `${t('gateway.statusAvailable')} (${accountStats.healthy})`
                    },
                    {
                      value: 'problematic',
                      label: `${t('logs.error')} (${accountStats.problematic})`
                    }
                  ]}
                />
                {isKiro && (
                  <Button size="sm" variant="primary" onClick={() => setDialogOpen(true)}>
                    {t('gateway.addAccount')}
                  </Button>
                )}
              </div>

              <div className="card overflow-hidden">
                {filteredAccounts.map((acc, i) => (
                  <AccountRow
                    key={acc.id}
                    account={acc}
                    info={accountInfoMap[acc.id]}
                    busy={busy}
                    expanded={expandedId === acc.id}
                    onToggleExpand={() => setExpandedId(expandedId === acc.id ? null : acc.id)}
                    last={i === filteredAccounts.length - 1}
                    onToggle={() =>
                      run(
                        () => window.api.gateway.toggleKiroAccount(acc.id, !acc.enabled),
                        acc.enabled ? t('gateway.disabled') : t('gateway.enabled')
                      )
                    }
                    onRemove={() => setRemoveTarget({ id: acc.id, label: acc.label || acc.id })}
                    onReset={() =>
                      run(() => window.api.gateway.resetKiroAccount(acc.id), t('gateway.resetDone'))
                    }
                    onPauseToggle={() => {
                      const isPaused = acc.status === 'manual_disabled'
                      return run(
                        () =>
                          window.api.gateway.setKiroAccountStatus(
                            acc.id,
                            isPaused ? 'available' : 'manual_disabled'
                          ),
                        isPaused ? t('gateway.resumed') : t('gateway.paused')
                      )
                    }}
                    onRefreshInfo={() => fetchAccountInfo(acc.id)}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}

      {isKiro && (
        <AddAccountDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          busy={busy}
          onAdd={run}
          onImported={refresh}
        />
      )}

      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(v) => {
          if (!v) setRemoveTarget(null)
        }}
        title={t('gateway.remove')}
        description={t('gateway.removeConfirm', { name: removeTarget?.label ?? '' })}
        confirmLabel={t('gateway.remove')}
        cancelLabel={t('common.cancel')}
        variant="danger"
        loading={busy}
        onConfirm={() => {
          if (removeTarget) {
            run(
              () => window.api.gateway.removeKiroAccount(removeTarget.id),
              t('gateway.removed')
            ).then(() => setRemoveTarget(null))
          }
        }}
      />
    </div>
  )
}

function AccountRow({
  account: acc,
  info,
  busy,
  expanded,
  onToggleExpand,
  last,
  onToggle,
  onRemove,
  onReset,
  onPauseToggle,
  onRefreshInfo
}: {
  account: Account
  info?: { data?: AccountInfo; loading: boolean; error?: string }
  busy: boolean
  expanded: boolean
  onToggleExpand: () => void
  last: boolean
  onToggle: () => void
  onRemove: () => void
  onReset: () => void
  onPauseToggle: () => void
  onRefreshInfo: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [modelsExpanded, setModelsExpanded] = useState(false)
  const status: AccountStatus = acc.status ?? 'available'
  const isPaused = status === 'manual_disabled'
  const statusVisual = getStatusVisual(status)
  const now = useNow()
  const dotClass = !acc.enabled ? 'pulse-dot-gray' : statusVisual.dotClass
  const total = acc.stats?.totalRequests ?? 0
  const success = acc.stats?.successfulRequests ?? 0
  const rate = total > 0 ? Math.round((success / total) * 100) : null
  const accountInfo = info?.data

  const expiresAt = acc.expiresAt ? new Date(acc.expiresAt) : null
  const expiresIn = expiresAt ? expiresAt.getTime() - now : null
  const expiryUrgent = expiresIn !== null && expiresIn < 24 * 3600_000

  const usagePercent = accountInfo?.usage
    ? Math.round((accountInfo.usage.used / Math.max(1, accountInfo.usage.limit)) * 100)
    : null
  const hasOverage = (accountInfo?.usage?.overages ?? 0) > 0

  const cooldownRemaining =
    acc.cooldownUntil && acc.cooldownUntil > now ? acc.cooldownUntil - now : null

  const borderColor = (() => {
    if (!acc.enabled) return 'border-l-fog/40'
    switch (status) {
      case 'available':
        return 'border-l-emerald'
      case 'cooling':
      case 'rate_limited':
        return 'border-l-warning'
      case 'quota_exceeded':
      case 'auth_failed':
        return 'border-l-red'
      case 'manual_disabled':
      default:
        return 'border-l-fog/30'
    }
  })()

  return (
    <div
      className={`border-l-[2.5px] ${borderColor} ${!last ? 'border-b border-b-charcoal/30' : ''} ${!acc.enabled ? 'opacity-50' : ''} transition-colors duration-75 ${expanded ? 'bg-[color-mix(in_srgb,var(--c-slate)_50%,transparent)]' : ''}`}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onToggleExpand}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggleExpand()
          }
        }}
        className={`flex items-center gap-2 px-3 py-2 cursor-pointer select-none ${expanded ? '' : 'hover:bg-[color-mix(in_srgb,var(--c-slate)_30%,transparent)]'}`}
      >
        <span className={dotClass} />
        <span className="text-[13px] font-medium text-porcelain truncate min-w-0 flex-1">
          {accountInfo?.email || acc.label || acc.id}
        </span>
        {accountInfo?.subscription &&
          accountInfo.subscription.type !== 'unknown' &&
          accountInfo.subscription.title &&
          !/^[\s—–-]+$/.test(accountInfo.subscription.title) && (
            <span className="tag text-[10px] !px-1.5 !py-0 text-lime bg-lime/10 border border-lime/20 shrink-0">
              {accountInfo.subscription.title}
            </span>
          )}
        <span className={`${statusVisual.badgeClass} !px-1.5 !py-0 shrink-0 text-[10px]`}>
          {t(`gateway.${statusVisual.i18nKey}`)}
          {cooldownRemaining && (
            <span className="ml-0.5 font-mono tabular-nums opacity-90">
              ({formatDuration(cooldownRemaining)})
            </span>
          )}
        </span>
        {usagePercent !== null && usagePercent > 80 && (
          <TooltipWrapper
            content={`${t('gateway.usage')}: ${accountInfo!.usage.used}/${accountInfo!.usage.limit}`}
          >
            <span
              className={`text-[10px] font-mono tabular-nums shrink-0 ${hasOverage ? 'text-red' : 'text-warning'}`}
            >
              {usagePercent}%
            </span>
          </TooltipWrapper>
        )}
        {total > 0 && (
          <TooltipWrapper
            content={`${t('gateway.requests')}: ${total} (${t('gateway.success')}: ${success})`}
          >
            <span className="text-[11px] text-fog font-mono tabular-nums shrink-0 flex items-center gap-0.5">
              <span className="i-ph-arrow-up-right text-[10px]" aria-hidden="true" />
              {total}
            </span>
          </TooltipWrapper>
        )}
        {(() => {
          const errMsg = info?.error || accountInfo?.error || acc.lastError
          if (!errMsg) return null
          return (
            <TooltipWrapper content={errMsg}>
              <span
                className="i-ph-warning-circle-fill text-red text-[13px] shrink-0 cursor-help"
                aria-hidden="true"
              />
            </TooltipWrapper>
          )
        })()}
        <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
          <TooltipWrapper content={t('gateway.refresh')}>
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              onClick={onRefreshInfo}
              disabled={info?.loading}
              aria-label={t('gateway.refresh')}
              className="!h-6 !w-6"
            >
              <span
                aria-hidden="true"
                className={`text-[12px] text-storm ${info?.loading ? 'i-svg-spinners:ring-resize' : 'i-ph-arrows-clockwise'}`}
              />
            </Button>
          </TooltipWrapper>
          {acc.failures > 0 && (
            <TooltipWrapper content={t('gateway.reset')}>
              <Button
                variant="ghost"
                size="xs"
                iconOnly
                disabled={busy}
                onClick={onReset}
                aria-label={t('gateway.reset')}
                className="!h-6 !w-6"
              >
                <span
                  aria-hidden="true"
                  className="i-ph-arrow-counter-clockwise text-[12px] text-storm"
                />
              </Button>
            </TooltipWrapper>
          )}
          {acc.enabled && (
            <TooltipWrapper content={isPaused ? t('gateway.resume') : t('gateway.pause')}>
              <Button
                variant="ghost"
                size="xs"
                iconOnly
                disabled={busy}
                onClick={onPauseToggle}
                aria-label={isPaused ? t('gateway.resume') : t('gateway.pause')}
                className="!h-6 !w-6"
              >
                <span
                  aria-hidden="true"
                  className={`text-[12px] text-storm ${isPaused ? 'i-ph-play' : 'i-ph-pause'}`}
                />
              </Button>
            </TooltipWrapper>
          )}
          <TooltipWrapper content={acc.enabled ? t('gateway.disable') : t('gateway.enable')}>
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              disabled={busy}
              onClick={onToggle}
              aria-label={acc.enabled ? t('gateway.disable') : t('gateway.enable')}
              className="!h-6 !w-6"
            >
              <span
                aria-hidden="true"
                className={`text-[12px] text-storm ${acc.enabled ? 'i-ph-power' : 'i-ph-power text-emerald'}`}
              />
            </Button>
          </TooltipWrapper>
          <TooltipWrapper content={t('gateway.remove')}>
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              disabled={busy}
              onClick={onRemove}
              aria-label={t('gateway.remove')}
              className="!h-6 !w-6"
            >
              <span
                aria-hidden="true"
                className="i-ph-trash text-[12px] text-storm hover:text-red"
              />
            </Button>
          </TooltipWrapper>
        </div>
        <span
          className={`i-ph-caret-down text-[11px] text-fog shrink-0 transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-1 animate-slide-down space-y-3">
          {accountInfo?.usage && (
            <div className="flex items-center gap-2 text-[11px]">
              <div
                role="progressbar"
                aria-valuenow={accountInfo.usage.used}
                aria-valuemin={0}
                aria-valuemax={accountInfo.usage.limit}
                aria-label={t('gateway.usage')}
                className="flex-1 h-1.5 rounded-full bg-charcoal/50 overflow-hidden"
              >
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    hasOverage ? 'bg-red' : usagePercent! > 80 ? 'bg-warning' : 'bg-emerald'
                  }`}
                  style={{ width: `${Math.min(usagePercent!, 100)}%` }}
                />
              </div>
              <span
                className={`font-mono tabular-nums font-medium shrink-0 ${hasOverage ? 'text-red' : 'text-storm'}`}
              >
                {accountInfo.usage.used}/{accountInfo.usage.limit}
              </span>
            </div>
          )}

          <div className="text-[11px] flex flex-wrap gap-x-5 gap-y-1">
            {rate !== null && (
              <div className="flex items-center gap-1.5">
                <span className="text-fog">{t('gateway.successRate')}</span>
                <span
                  className={`font-mono tabular-nums font-medium ${statusVisual.rateColorClass}`}
                >
                  {rate}%
                </span>
              </div>
            )}
            {accountInfo?.usage?.resetDate && (
              <div className="flex items-center gap-1.5">
                <span className="text-fog">{t('gateway.resetDate')}</span>
                <span className="font-mono tabular-nums text-storm">
                  {formatResetDate(accountInfo.usage.resetDate)}
                </span>
              </div>
            )}
            {expiresAt && (
              <div className="flex items-center gap-1.5">
                <span className="text-fog">{t('gateway.expires')}</span>
                <span
                  className={`font-mono tabular-nums ${expiryUrgent ? 'text-red' : 'text-storm'}`}
                >
                  {formatDuration(expiresIn!)}
                </span>
              </div>
            )}
            {hasOverage && accountInfo?.usage && (
              <div className="flex items-center gap-1.5">
                <span className="text-fog">{t('gateway.overages')}</span>
                <span className="font-mono tabular-nums text-red">
                  +{accountInfo.usage.overages} (${accountInfo.usage.overageCharges.toFixed(2)})
                </span>
              </div>
            )}
          </div>

          {accountInfo?.models && accountInfo.models.length > 0 && (
            <div>
              <button
                className="text-[11px] text-fog hover:text-storm inline-flex items-center gap-1 font-medium transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  setModelsExpanded(!modelsExpanded)
                }}
              >
                <span className="text-[9px]" aria-hidden="true">
                  {modelsExpanded ? '▼' : '▶'}
                </span>
                {t('gateway.models')} ({accountInfo.models.length})
              </button>
              {modelsExpanded && (
                <div className="flex flex-wrap gap-1 mt-1.5 animate-slide-down">
                  {accountInfo.models.map((m) => (
                    <span
                      key={m.modelId}
                      className="tag text-[10px] font-mono !px-1.5 !py-0 bg-charcoal/40 text-storm"
                    >
                      {m.modelName || m.modelId}
                      {m.rateMultiplier > 1 && (
                        <span className="ml-0.5 text-warning font-semibold">
                          {m.rateMultiplier}x
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {info?.loading && !accountInfo && (
            <span className="text-[11px] text-fog">{t('gateway.loadingInfo')}…</span>
          )}
        </div>
      )}
    </div>
  )
}

function AddAccountDialog({
  open,
  onOpenChange,
  onImported
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  busy: boolean
  onAdd: (action: () => Promise<any>, msg: string) => Promise<void>
  onImported: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState('cli')

  // Discover tab
  const [discoverLoading, setDiscoverLoading] = useState(false)
  const [scanResult, setScanResult] = useState<{
    candidates: Array<{
      id: string
      label?: string
      email?: string
      refreshToken?: string
      profileArn?: string
      existing?: boolean
      sourceType?: string
    }>
  } | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Token tab
  const [tokenText, setTokenText] = useState('')
  const [tokenType, setTokenType] = useState<'refresh' | 'access'>('refresh')
  const [tokenLoading, setTokenLoading] = useState(false)
  const [tokenMsg, setTokenMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // JSON tab
  const [jsonText, setJsonText] = useState('')
  const [jsonLoading, setJsonLoading] = useState(false)
  const [jsonResult, setJsonResult] = useState<{
    added: number
    skipped: number
    errors: string[]
  } | null>(null)

  // CLI tab
  const [cliState, setCliState] = useState<
    'detecting' | 'found' | 'not_found' | 'logging_in' | 'success' | 'failed'
  >('detecting')
  const [cliPath, setCliPath] = useState('')
  const [cliVersion, setCliVersion] = useState('')
  const [cliOutput, setCliOutput] = useState('')
  const [cliExitCode, setCliExitCode] = useState<number | null>(null)
  const [cliCopyOk, setCliCopyOk] = useState(false)

  useEffect(() => {
    if (open && tab === 'cli' && cliState === 'detecting') {
      window.api.gateway.detectKiroCli().then((r) => {
        if (r.found) {
          setCliState('found')
          setCliPath(r.path)
          setCliVersion(r.version || '')
        } else {
          setCliState('not_found')
        }
      })
    }
  }, [open, tab, cliState])

  useEffect(() => {
    if (cliState !== 'logging_in') return
    let output = ''
    const unsub = window.api.gateway.onCliLoginOutput((data) => {
      if (data.type === 'stdout' || data.type === 'stderr') {
        output += data.text || ''
        setCliOutput((prev) => prev + (data.text || ''))
      } else if (data.type === 'exit') {
        const alreadyLoggedIn = /already logged in/i.test(output)
        if (data.code === 0 || alreadyLoggedIn) {
          if (data.imported) {
            setCliState('success')
            onImported()
            onOpenChange(false)
          } else {
            setCliState('failed')
            setCliOutput((prev) => prev + (data.error || 'Failed to extract credentials from CLI'))
            setCliExitCode(-1)
          }
        } else {
          setCliState('failed')
          setCliExitCode(data.code ?? -1)
        }
      } else if (data.type === 'error') {
        setCliState('failed')
        setCliOutput((prev) => prev + (data.message || ''))
      }
    })
    return unsub
  }, [cliState, onImported, onOpenChange])

  async function handleScan() {
    setDiscoverLoading(true)
    setScanResult(null)
    setSelectedIds(new Set())
    try {
      const r = await window.api.gateway.scanKiroAccounts()
      setScanResult(r)
      const newIds = new Set(r.candidates.filter((c: any) => !c.existing).map((c: any) => c.id))
      setSelectedIds(newIds)
    } finally {
      setDiscoverLoading(false)
    }
  }

  async function handleImportSelected() {
    setDiscoverLoading(true)
    try {
      await window.api.gateway.importScannedAccounts([...selectedIds])
      setScanResult(null)
      setSelectedIds(new Set())
      onOpenChange(false)
      onImported()
    } finally {
      setDiscoverLoading(false)
    }
  }

  async function handleToken() {
    if (!tokenText.trim()) return
    setTokenLoading(true)
    setTokenMsg(null)
    try {
      if (tokenType === 'access') {
        await window.api.gateway.addKiroAccessToken(tokenText)
      } else {
        await window.api.gateway.addKiroRefreshToken(tokenText)
      }
      setTokenMsg({ ok: true, text: t('addAccount.tokenValid') })
      setTokenText('')
      onImported()
    } catch (err: any) {
      setTokenMsg({ ok: false, text: err?.message || t('addAccount.tokenInvalid') })
    } finally {
      setTokenLoading(false)
    }
  }

  async function handleJson() {
    if (!jsonText.trim()) return
    setJsonLoading(true)
    setJsonResult(null)
    try {
      const r = await window.api.gateway.importKiroJson(jsonText)
      setJsonResult({ added: r.added, skipped: r.skipped, errors: r.errors })
      if (r.added > 0) {
        setJsonText('')
        onImported()
      }
    } catch (err: any) {
      setJsonResult({ added: 0, skipped: 0, errors: [err?.message || 'Unknown error'] })
    } finally {
      setJsonLoading(false)
    }
  }

  function handleCliLogin() {
    setCliState('logging_in')
    setCliOutput('')
    setCliExitCode(null)
    setCliCopyOk(false)
    window.api.gateway.loginWithKiroCli({ cliPath: cliPath || undefined })
  }

  async function handleCopyCliLink(link: string) {
    await navigator.clipboard.writeText(link)
    setCliCopyOk(true)
    window.setTimeout(() => setCliCopyOk(false), 1500)
  }

  function handleCliCancel() {
    window.api.gateway.cancelKiroCliLogin()
    setCliState('found')
    setCliOutput('')
  }

  return (
    <Modal
      open={open}
      onOpenChange={(v) => {
        if (!v && cliState === 'logging_in') {
          window.api.gateway.cancelKiroCliLogin()
          setCliState('found')
          setCliOutput('')
        }
        onOpenChange(v)
      }}
      title={t('addAccount.title')}
    >
      <TabGroup
        value={tab}
        onValueChange={setTab}
        items={[
          {
            value: 'cli',
            label: t('addAccount.tabs.cli'),
            content: (
              <>
                {cliState === 'detecting' && (
                  <p className="text-[12px] text-fog">{t('addAccount.cliDetecting')}</p>
                )}
                {cliState === 'not_found' && (
                  <div className="space-y-1">
                    <p className="text-[12px] text-warning">{t('addAccount.cliNotFound')}</p>
                    <p className="text-[12px] text-fog">{t('addAccount.cliInstallHint')}</p>
                  </div>
                )}
                {(cliState === 'found' || cliState === 'success' || cliState === 'failed') && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] text-fog">
                        {t('addAccount.cliFound', { path: cliPath })}
                      </span>
                      {cliVersion && <span className="tag text-[12px]">{cliVersion}</span>}
                    </div>
                    {cliState === 'found' && (
                      <Button variant="primary" onClick={handleCliLogin}>
                        {t('addAccount.cliLogin')}
                      </Button>
                    )}
                    {cliState === 'success' && (
                      <p className="text-[12px] text-emerald">{t('addAccount.cliSuccess')}</p>
                    )}
                    {cliState === 'failed' && (
                      <p className="text-[12px] text-red">
                        {t('addAccount.cliFailed', { code: cliExitCode })}
                      </p>
                    )}
                  </div>
                )}
                {cliState === 'logging_in' && (
                  <div className="space-y-2">
                    {(() => {
                      const codeMatch = cliOutput.match(/Code:\s*([A-Z0-9-]+)/i)
                      const urlMatch = cliOutput.match(/https?:\/\/[^\s]+/)
                      const verifyUrl =
                        urlMatch?.[0] || 'https://device.sso.us-east-1.amazonaws.com/'
                      return (
                        <>
                          {codeMatch ? (
                            <div className="space-y-2 text-center py-2">
                              <p className="text-[12px] text-fog">
                                复制下面的链接到你想使用的浏览器，并输入验证码：
                              </p>
                              <div className="flex items-center gap-2 rounded-[var(--radius-md)] bg-pitch px-2 py-1.5 text-left">
                                <span className="flex-1 text-[12px] text-lime break-all select-all">
                                  {verifyUrl}
                                </span>
                                <Button size="sm" onClick={() => handleCopyCliLink(verifyUrl)}>
                                  {cliCopyOk ? '已复制' : '复制'}
                                </Button>
                              </div>
                              <p className="text-[22px] font-mono font-[700] text-porcelain tracking-[0.2em]">
                                {codeMatch[1]}
                              </p>
                              <p className="text-[12px] text-fog animate-pulse">等待验证完成...</p>
                            </div>
                          ) : (
                            <pre className="text-[12px] font-mono bg-pitch rounded-[var(--radius-md)] p-3 max-h-36 overflow-y-auto whitespace-pre-wrap text-storm">
                              {cliOutput || '...'}
                            </pre>
                          )}
                        </>
                      )
                    })()}
                    <Button onClick={handleCliCancel}>{t('addAccount.cliCancel')}</Button>
                  </div>
                )}
              </>
            )
          },
          {
            value: 'token',
            label: t('addAccount.tabs.token'),
            content: (
              <>
                <SegmentedControl
                  value={tokenType}
                  onValueChange={(v) => setTokenType(v as 'refresh' | 'access')}
                  items={[
                    { value: 'refresh', label: 'Refresh Token' },
                    { value: 'access', label: 'Access Token' }
                  ]}
                />
                <textarea
                  value={tokenText}
                  onChange={(e) => setTokenText(e.target.value)}
                  placeholder={
                    tokenType === 'refresh'
                      ? t('addAccount.tokenPlaceholder')
                      : t('addAccount.accessTokenPlaceholder')
                  }
                  className="input-base font-mono text-[12px] min-h-20 resize-y w-full"
                />
                <div className="flex items-center gap-3">
                  <Button
                    variant="primary"
                    onClick={handleToken}
                    disabled={tokenLoading || !tokenText.trim()}
                  >
                    {tokenLoading ? t('addAccount.tokenValidating') : t('common.add')}
                  </Button>
                  {tokenMsg && (
                    <p className={`text-[12px] ${tokenMsg.ok ? 'text-emerald' : 'text-red'}`}>
                      {tokenMsg.text}
                    </p>
                  )}
                </div>
              </>
            )
          },
          {
            value: 'json',
            label: t('addAccount.tabs.json'),
            content: (
              <>
                <textarea
                  value={jsonText}
                  onChange={(e) => setJsonText(e.target.value)}
                  placeholder={t('addAccount.jsonPlaceholder')}
                  className="input-base font-mono text-[12px] min-h-24 resize-y w-full"
                />
                <div className="flex items-center gap-3">
                  <Button
                    variant="primary"
                    onClick={handleJson}
                    disabled={jsonLoading || !jsonText.trim()}
                  >
                    {jsonLoading ? t('addAccount.jsonImporting') : t('common.add')}
                  </Button>
                  <Button
                    onClick={() => {
                      const input = document.createElement('input')
                      input.type = 'file'
                      input.accept = '.json,application/json'
                      input.onchange = async () => {
                        const file = input.files?.[0]
                        if (!file) return
                        const text = await file.text()
                        setJsonText(text)
                      }
                      input.click()
                    }}
                  >
                    {t('addAccount.jsonSelectFile')}
                  </Button>
                  {jsonResult && (
                    <span className="text-[12px] text-fog">
                      {t('addAccount.jsonResult', jsonResult)}
                    </span>
                  )}
                </div>
                {jsonResult && jsonResult.errors.length > 0 && (
                  <div className="text-[12px] text-red space-y-0.5">
                    <p>{t('addAccount.jsonErrors', { count: jsonResult.errors.length })}</p>
                    {jsonResult.errors.map((e, i) => (
                      <p key={i} className="truncate opacity-80">
                        {e}
                      </p>
                    ))}
                  </div>
                )}
              </>
            )
          },
          {
            value: 'discover',
            label: t('addAccount.tabs.discover'),
            content: (
              <>
                <p className="text-[12px] text-fog">{t('gateway.discoverTip')}</p>
                {!scanResult && (
                  <Button variant="primary" onClick={handleScan} disabled={discoverLoading}>
                    {discoverLoading ? t('addAccount.discoverRunning') : t('gateway.discover')}
                  </Button>
                )}
                {scanResult && scanResult.candidates.length === 0 && (
                  <p className="text-[12px] text-fog">{t('addAccount.discoverEmpty')}</p>
                )}
                {scanResult && scanResult.candidates.length > 0 && (
                  <div className="space-y-2">
                    <div className="space-y-1">
                      {scanResult.candidates.map((c) => (
                        <label
                          key={c.id}
                          className={`flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-sm)] ${c.existing ? 'opacity-40' : 'hover:bg-[color-mix(in_srgb,var(--c-slate)_30%,transparent)]'}`}
                        >
                          <input
                            type="checkbox"
                            checked={selectedIds.has(c.id)}
                            disabled={c.existing}
                            onChange={(e) => {
                              const next = new Set(selectedIds)
                              if (e.target.checked) next.add(c.id)
                              else next.delete(c.id)
                              setSelectedIds(next)
                            }}
                            className="custom-checkbox"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="text-[12px] text-porcelain truncate">
                              {c.label || c.email || c.id}
                            </p>
                            <p className="text-[12px] text-fog font-mono truncate">
                              {c.email ||
                                (c.refreshToken
                                  ? c.refreshToken.slice(0, 20) + '...'
                                  : c.sourceType || c.id)}
                            </p>
                          </div>
                          <span className="tag text-[12px] !px-1 !py-0 shrink-0">
                            {c.existing ? t('gateway.exists') : c.sourceType || 'account'}
                          </span>
                        </label>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="primary"
                        onClick={handleImportSelected}
                        disabled={selectedIds.size === 0 || discoverLoading}
                      >
                        {t('common.add')} ({selectedIds.size})
                      </Button>
                      <Button
                        onClick={() => {
                          setScanResult(null)
                          setSelectedIds(new Set())
                        }}
                      >
                        {t('common.cancel')}
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )
          }
        ]}
      />
    </Modal>
  )
}

function getStatusVisual(status: AccountStatus): {
  i18nKey: string
  dotClass: string
  badgeClass: string
  rateColorClass: string
} {
  switch (status) {
    case 'available':
      return {
        i18nKey: 'statusAvailable',
        dotClass: 'pulse-dot-green',
        badgeClass: 'badge text-emerald',
        rateColorClass: 'text-emerald'
      }
    case 'cooling':
      return {
        i18nKey: 'statusCooling',
        dotClass: 'pulse-dot-warning',
        badgeClass: 'badge text-warning',
        rateColorClass: 'text-warning'
      }
    case 'rate_limited':
      return {
        i18nKey: 'statusRateLimited',
        dotClass: 'pulse-dot-warning',
        badgeClass: 'badge text-warning',
        rateColorClass: 'text-warning'
      }
    case 'quota_exceeded':
      return {
        i18nKey: 'statusQuotaExceeded',
        dotClass: 'pulse-dot-red',
        badgeClass: 'badge text-red',
        rateColorClass: 'text-red'
      }
    case 'auth_failed':
      return {
        i18nKey: 'statusAuthFailed',
        dotClass: 'pulse-dot-red',
        badgeClass: 'badge text-red',
        rateColorClass: 'text-red'
      }
    case 'manual_disabled':
    default:
      return {
        i18nKey: 'statusManualDisabled',
        dotClass: 'pulse-dot-gray',
        badgeClass: 'badge text-fog',
        rateColorClass: 'text-fog'
      }
  }
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3600_000)
  const minutes = Math.floor((ms % 3600_000) / 60_000)
  if (hours > 24) return `${Math.floor(hours / 24)}d`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function formatResetDate(value: string | number): string {
  if (!value) return ''
  const ts =
    typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : new Date(value).getTime()
  if (isNaN(ts) || ts < 1e12) return String(value)
  return new Date(ts).toLocaleDateString()
}
