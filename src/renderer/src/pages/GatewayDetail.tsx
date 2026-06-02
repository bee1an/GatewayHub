import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { usePolling } from '../hooks/usePolling'
import { Button } from '../components/ui/Button'
import { ConfirmDialog } from '../components/ui/ConfirmDialog'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { TooltipWrapper } from '../components/ui/Tooltip'
import { useToast } from '../components/ui/ToastContext'
import { ProviderLogo } from '../components/ProviderLogo'
import { getProviderLogoLabel } from '../components/providerLogoData'
import { useTheme } from '../components/useTheme'
import Usage from './Usage'
import { AccountRow } from './GatewayAccountRow'
import { AddKiroAccountDialog } from './AddKiroAccountDialog'
import { AddCodexAccountDialog } from './AddCodexAccountDialog'
import { AddWindsurfAccountDialog } from './AddWindsurfAccountDialog'
import { AddTraeAccountDialog } from './AddTraeAccountDialog'
import { AddOpenRouterAccountDialog } from './AddOpenRouterAccountDialog'
import { AddNvidiaAccountDialog } from './AddNvidiaAccountDialog'
import { AddGptWebAccountDialog } from './AddGptWebAccountDialog'
import { AddGrokWebAccountDialog } from './AddGrokWebAccountDialog'
import { normalizeAccountModels } from './accountModelUtils'

import type { Account, AccountFilter, AccountInfo, GatewayStatus } from './gatewayDetailTypes'
const accountInfoCache: Record<string, { data?: AccountInfo; loading: boolean; error?: string }> =
  {}

export default function GatewayDetail(): React.JSX.Element {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { theme } = useTheme()
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
  const [modelRefreshIds, setModelRefreshIds] = useState<Set<string>>(() => new Set())

  const draftValue =
    routeNameDraft && routeNameDraft.name === name ? routeNameDraft.value : (name ?? '')

  const gateway = useMemo(() => status?.providers.find((p) => p.name === name), [status, name])
  const gatewayLabel = gateway
    ? getProviderLogoLabel(gateway.providerType, gateway.displayName)
    : undefined
  const accounts = useMemo<Account[]>(() => gateway?.accounts ?? [], [gateway?.accounts])
  const isKiro = gateway?.providerType === 'kiro'
  const isCodex = gateway?.providerType === 'codex'
  const isWindsurf = gateway?.providerType === 'windsurf'
  const isTrae = gateway?.providerType === 'trae'
  const isOpenRouter = gateway?.providerType === 'openrouter'
  const isNvidia = gateway?.providerType === 'nvidia'
  const isGptWeb = gateway?.providerType === 'gptWeb'
  const isGrokWeb = gateway?.providerType === 'grokWeb'
  const supportsAccounts =
    isKiro || isCodex || isWindsurf || isTrae || isOpenRouter || isNvidia || isGptWeb || isGrokWeb
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

  const fetchAccountInfo = useCallback(
    async (accountId: string) => {
      setAccountInfoMap((prev) => ({ ...prev, [accountId]: { ...prev[accountId], loading: true } }))
      try {
        const info = isCodex
          ? await window.api.gateway.getCodexAccountInfo(accountId)
          : isWindsurf
            ? await window.api.gateway.getWindsurfAccountInfo(accountId)
            : isTrae
              ? await window.api.gateway.getTraeAccountInfo(accountId)
              : isOpenRouter
                ? await window.api.gateway.getOpenRouterAccountInfo(accountId)
                : isNvidia
                  ? await window.api.gateway.getNvidiaAccountInfo(accountId)
                  : isGptWeb
                    ? await window.api.gateway.getGptWebAccountInfo(accountId)
                    : isGrokWeb
                      ? await window.api.gateway.getGrokWebAccountInfo(accountId)
                      : await window.api.gateway.getAccountInfo(accountId)
        const normalizedInfo = { ...info, models: normalizeAccountModels(info?.models) }
        setAccountInfoMap((prev) => {
          const next = { ...prev, [accountId]: { data: normalizedInfo, loading: false } }
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
    },
    [isCodex, isWindsurf, isTrae, isOpenRouter, isNvidia, isGptWeb, isGrokWeb]
  )

  const fetchAllUsage = useCallback(() => {
    accounts.filter((a) => a.enabled).forEach((acc) => fetchAccountInfo(acc.id))
  }, [accounts, fetchAccountInfo])

  const refreshAccountModels = useCallback(
    async (accountId: string) => {
      if (
        !isKiro &&
        !isWindsurf &&
        !isTrae &&
        !isOpenRouter &&
        !isNvidia &&
        !isGptWeb &&
        !isGrokWeb
      )
        return
      setModelRefreshIds((prev) => new Set(prev).add(accountId))
      try {
        const result = isWindsurf
          ? await window.api.gateway.refreshWindsurfAccountModels(accountId)
          : isTrae
            ? await window.api.gateway.refreshTraeAccountModels(accountId)
            : isOpenRouter
              ? await window.api.gateway.refreshOpenRouterAccountModels(accountId)
              : isNvidia
                ? await window.api.gateway.refreshNvidiaAccountModels(accountId)
                : isGptWeb
                  ? await window.api.gateway.refreshGptWebAccountModels(accountId)
                  : isGrokWeb
                    ? await window.api.gateway.refreshGrokWebAccountModels(accountId)
                    : await window.api.gateway.refreshKiroAccountModels(accountId)
        if (result?.ok === false) throw new Error(result.error || t('gateway.infoError'))
        const models = normalizeAccountModels(result?.models)
        setAccountInfoMap((prev) => {
          const previous = prev[accountId]
          if (!previous?.data) return prev
          const nextEntry = {
            ...previous,
            data: { ...previous.data, models },
            loading: false,
            error: undefined
          }
          const next = { ...prev, [accountId]: nextEntry }
          accountInfoCache[accountId] = nextEntry
          return next
        })
        await refresh()
        toast(t('gateway.modelsRefreshed', { count: models.length }), 'success')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setAccountInfoMap((prev) => {
          const nextEntry = { ...prev[accountId], loading: false, error: message }
          const next = { ...prev, [accountId]: nextEntry }
          accountInfoCache[accountId] = nextEntry
          return next
        })
        toast(message, 'error')
      } finally {
        setModelRefreshIds((prev) => {
          const next = new Set(prev)
          next.delete(accountId)
          return next
        })
      }
    },
    [isKiro, isWindsurf, isTrae, isOpenRouter, isNvidia, isGptWeb, isGrokWeb, refresh, t, toast]
  )

  useEffect(() => {
    if (!supportsAccounts) return
    accounts
      .filter((a) => a.enabled && !accountInfoMap[a.id])
      .forEach((acc) => fetchAccountInfo(acc.id))
  }, [accountIdsKey, accountInfoMap, accounts, fetchAccountInfo, supportsAccounts])

  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined)
  useEffect(() => {
    if (!supportsAccounts || !accounts.length) return
    pollRef.current = setInterval(fetchAllUsage, 5 * 60_000)
    return () => clearInterval(pollRef.current)
  }, [accounts.length, fetchAllUsage, supportsAccounts])

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
        <ProviderLogo
          providerType={gateway.providerType}
          label={gatewayLabel}
          theme={theme}
          size="md"
        />
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
          key={gateway.providerType}
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
            {supportsAccounts && (
              <Button size="sm" variant="primary" onClick={() => setDialogOpen(true)}>
                {t('gateway.addAccount')}
              </Button>
            )}
          </div>

          {accounts.length === 0 ? (
            <div className="card px-4 py-10 flex flex-col items-center gap-3">
              <span className="i-ph-users-three text-[28px] text-charcoal" aria-hidden="true" />
              <span className="text-fog text-[13px]">{t('gateway.noAccounts')}</span>
              {supportsAccounts && (
                <Button size="sm" variant="primary" onClick={() => setDialogOpen(true)}>
                  {t('gateway.addAccount')}
                </Button>
              )}
            </div>
          ) : (
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
                      () =>
                        isCodex
                          ? window.api.gateway.toggleCodexAccount(acc.id, !acc.enabled)
                          : isWindsurf
                            ? window.api.gateway.toggleWindsurfAccount(acc.id, !acc.enabled)
                            : isTrae
                              ? window.api.gateway.toggleTraeAccount(acc.id, !acc.enabled)
                              : isOpenRouter
                                ? window.api.gateway.toggleOpenRouterAccount(acc.id, !acc.enabled)
                                : isNvidia
                                  ? window.api.gateway.toggleNvidiaAccount(acc.id, !acc.enabled)
                                  : isGptWeb
                                    ? window.api.gateway.toggleGptWebAccount(acc.id, !acc.enabled)
                                    : isGrokWeb
                                      ? window.api.gateway.toggleGrokWebAccount(
                                          acc.id,
                                          !acc.enabled
                                        )
                                      : window.api.gateway.toggleKiroAccount(acc.id, !acc.enabled),
                      acc.enabled ? t('gateway.disabled') : t('gateway.enabled')
                    )
                  }
                  onRemove={() => setRemoveTarget({ id: acc.id, label: acc.label || acc.id })}
                  onReset={() =>
                    run(
                      () =>
                        isCodex
                          ? window.api.gateway.resetCodexAccount(acc.id)
                          : isWindsurf
                            ? window.api.gateway.resetWindsurfAccount(acc.id)
                            : isTrae
                              ? window.api.gateway.resetTraeAccount(acc.id)
                              : isOpenRouter
                                ? window.api.gateway.resetOpenRouterAccount(acc.id)
                                : isNvidia
                                  ? window.api.gateway.resetNvidiaAccount(acc.id)
                                  : isGptWeb
                                    ? window.api.gateway.resetGptWebAccount(acc.id)
                                    : isGrokWeb
                                      ? window.api.gateway.resetGrokWebAccount(acc.id)
                                      : window.api.gateway.resetKiroAccount(acc.id),
                      t('gateway.resetDone')
                    )
                  }
                  onPauseToggle={() => {
                    const isPaused = acc.status === 'manual_disabled'
                    return run(
                      () =>
                        isCodex
                          ? window.api.gateway.setCodexAccountStatus(
                              acc.id,
                              isPaused ? 'available' : 'manual_disabled'
                            )
                          : isWindsurf
                            ? window.api.gateway.setWindsurfAccountStatus(
                                acc.id,
                                isPaused ? 'available' : 'manual_disabled'
                              )
                            : isTrae
                              ? window.api.gateway.setTraeAccountStatus(
                                  acc.id,
                                  isPaused ? 'available' : 'manual_disabled'
                                )
                              : isOpenRouter
                                ? window.api.gateway.setOpenRouterAccountStatus(
                                    acc.id,
                                    isPaused ? 'available' : 'manual_disabled'
                                  )
                                : isNvidia
                                  ? window.api.gateway.setNvidiaAccountStatus(
                                      acc.id,
                                      isPaused ? 'available' : 'manual_disabled'
                                    )
                                  : isGptWeb
                                    ? window.api.gateway.setGptWebAccountStatus(
                                        acc.id,
                                        isPaused ? 'available' : 'manual_disabled'
                                      )
                                    : isGrokWeb
                                      ? window.api.gateway.setGrokWebAccountStatus(
                                          acc.id,
                                          isPaused ? 'available' : 'manual_disabled'
                                        )
                                      : window.api.gateway.setKiroAccountStatus(
                                          acc.id,
                                          isPaused ? 'available' : 'manual_disabled'
                                        ),
                      isPaused ? t('gateway.resumed') : t('gateway.paused')
                    )
                  }}
                  onRefreshInfo={() => fetchAccountInfo(acc.id)}
                  onRefreshModels={
                    isKiro ||
                    isWindsurf ||
                    isTrae ||
                    isOpenRouter ||
                    isNvidia ||
                    isGptWeb ||
                    isGrokWeb
                      ? () => refreshAccountModels(acc.id)
                      : undefined
                  }
                  modelsRefreshing={modelRefreshIds.has(acc.id)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {isKiro && (
        <AddKiroAccountDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          busy={busy}
          onAdd={run}
          onImported={refresh}
        />
      )}

      {isCodex && (
        <AddCodexAccountDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onImported={refresh}
        />
      )}

      {isWindsurf && (
        <AddWindsurfAccountDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onImported={refresh}
        />
      )}

      {isTrae && (
        <AddTraeAccountDialog open={dialogOpen} onOpenChange={setDialogOpen} onImported={refresh} />
      )}

      {isOpenRouter && (
        <AddOpenRouterAccountDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onImported={refresh}
        />
      )}

      {isNvidia && (
        <AddNvidiaAccountDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onImported={refresh}
        />
      )}

      {isGptWeb && (
        <AddGptWebAccountDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onImported={refresh}
        />
      )}

      {isGrokWeb && (
        <AddGrokWebAccountDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
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
              () =>
                isCodex
                  ? window.api.gateway.removeCodexAccount(removeTarget.id)
                  : isWindsurf
                    ? window.api.gateway.removeWindsurfAccount(removeTarget.id)
                    : isTrae
                      ? window.api.gateway.removeTraeAccount(removeTarget.id)
                      : isOpenRouter
                        ? window.api.gateway.removeOpenRouterAccount(removeTarget.id)
                        : isNvidia
                          ? window.api.gateway.removeNvidiaAccount(removeTarget.id)
                          : isGptWeb
                            ? window.api.gateway.removeGptWebAccount(removeTarget.id)
                            : isGrokWeb
                              ? window.api.gateway.removeGrokWebAccount(removeTarget.id)
                              : window.api.gateway.removeKiroAccount(removeTarget.id),
              t('gateway.removed')
            ).then(() => setRemoveTarget(null))
          }
        }}
      />
    </div>
  )
}
