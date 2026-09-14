import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
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
import { useQuery } from '@tanstack/react-query'
import Usage from './Usage'
import { AccountRow } from './GatewayAccountRow'
import { AddKiroAccountDialog } from './AddKiroAccountDialog'
import { AddCodexAccountDialog } from './AddCodexAccountDialog'
import { AddWindsurfAccountDialog } from './AddWindsurfAccountDialog'
import { AddTraeAccountDialog } from './AddTraeAccountDialog'
import { AddTraeWorkAccountDialog } from './AddTraeWorkAccountDialog'
import { AddWorkBuddyAccountDialog } from './AddWorkBuddyAccountDialog'
import { AddOpenRouterAccountDialog } from './AddOpenRouterAccountDialog'
import { AddNvidiaAccountDialog } from './AddNvidiaAccountDialog'
import { AddGptWebAccountDialog } from './AddGptWebAccountDialog'
import { AddGrokWebAccountDialog } from './AddGrokWebAccountDialog'
import { AddGeminiWebAccountDialog } from './AddGeminiWebAccountDialog'
import { AddQoderAccountDialog } from './AddQoderAccountDialog'
import { WindsurfProviderSettings } from './WindsurfProviderSettings'
import { normalizeAccountModels } from './accountModelUtils'

import type { Account, AccountFilter, AccountInfo, GatewayStatus } from './gatewayDetailTypes'
const accountInfoCache: Record<string, { data?: AccountInfo; loading: boolean; error?: string }> =
  {}

export default function GatewayDetail(): React.JSX.Element {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { theme } = useTheme()
  const { name } = useParams<{ name: string }>()
  const navigate = useNavigate()
  const { data: status, refresh } = usePolling<GatewayStatus>(
    () => window.api.gateway.status(),
    3000,
    ['gateway', 'status']
  )
  const [busy, setBusy] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [accountInfoMap, setAccountInfoMap] = useState(accountInfoCache)
  const [routeNameDraft, setRouteNameDraft] = useState<{ name: string; value: string } | null>(null)
  const [editingRouteName, setEditingRouteName] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<{ id: string; label: string } | null>(null)
  const [filter, setFilter] = useState<AccountFilter>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [tab, setTab] = useState<'overview' | 'settings' | 'usage'>('overview')
  const [modelRefreshIds, setModelRefreshIds] = useState<Set<string>>(() => new Set())
  const [globalProxyUrl, setGlobalProxyUrl] = useState('')
  const [proxyToggleSaving, setProxyToggleSaving] = useState(false)
  const [autoCheckin, setAutoCheckin] = useState<boolean | null>(null)
  const [checkinToggleSaving, setCheckinToggleSaving] = useState(false)

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
  const isTraeWork = gateway?.providerType === 'traework'
  const isWorkBuddy = gateway?.providerType === 'workbuddy'
  const isOpenRouter = gateway?.providerType === 'openrouter'
  const isNvidia = gateway?.providerType === 'nvidia'
  const isGptWeb = gateway?.providerType === 'gptWeb'
  const isGrokWeb = gateway?.providerType === 'grokWeb'
  const isQoder = gateway?.providerType === 'qoder'
  const isGeminiWeb = gateway?.providerType === 'geminiWeb'
  const supportsProxy =
    isKiro ||
    isCodex ||
    isWindsurf ||
    isTrae ||
    isTraeWork ||
    isWorkBuddy ||
    isGptWeb ||
    isGrokWeb ||
    isQoder ||
    isGeminiWeb
  const supportsAccounts =
    isKiro ||
    isCodex ||
    isWindsurf ||
    isTrae ||
    isTraeWork ||
    isWorkBuddy ||
    isOpenRouter ||
    isNvidia ||
    isGptWeb ||
    isGrokWeb ||
    isQoder ||
    isGeminiWeb
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
              : isTraeWork
                ? await window.api.gateway.getTraeWorkAccountInfo(accountId)
                : isWorkBuddy
                  ? await window.api.gateway.getWorkBuddyAccountInfo(accountId)
                  : isOpenRouter
                    ? await window.api.gateway.getOpenRouterAccountInfo(accountId)
                    : isNvidia
                      ? await window.api.gateway.getNvidiaAccountInfo(accountId)
                      : isGptWeb
                        ? await window.api.gateway.getGptWebAccountInfo(accountId)
                        : isGrokWeb
                          ? await window.api.gateway.getGrokWebAccountInfo(accountId)
                          : isGeminiWeb
                            ? await window.api.gateway.getGeminiWebAccountInfo(accountId)
                            : isQoder
                              ? await window.api.gateway.getQoderAccountInfo(accountId)
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
    [
      isCodex,
      isWindsurf,
      isTrae,
      isTraeWork,
      isWorkBuddy,
      isOpenRouter,
      isNvidia,
      isGptWeb,
      isGrokWeb,
      isQoder,
      isGeminiWeb
    ]
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
        !isTraeWork &&
        !isWorkBuddy &&
        !isOpenRouter &&
        !isNvidia &&
        !isGptWeb &&
        !isGrokWeb &&
        !isQoder &&
        !isGeminiWeb
      )
        return
      setModelRefreshIds((prev) => new Set(prev).add(accountId))
      try {
        const result = isWindsurf
          ? await window.api.gateway.refreshWindsurfAccountModels(accountId)
          : isTrae
            ? await window.api.gateway.refreshTraeAccountModels(accountId)
            : isTraeWork
              ? await window.api.gateway.refreshTraeWorkAccountModels(accountId)
              : isWorkBuddy
                ? await window.api.gateway.refreshWorkBuddyAccountModels(accountId)
                : isOpenRouter
                  ? await window.api.gateway.refreshOpenRouterAccountModels(accountId)
                  : isNvidia
                    ? await window.api.gateway.refreshNvidiaAccountModels(accountId)
                    : isGptWeb
                      ? await window.api.gateway.refreshGptWebAccountModels(accountId)
                      : isGrokWeb
                        ? await window.api.gateway.refreshGrokWebAccountModels(accountId)
                        : isGeminiWeb
                          ? await window.api.gateway.refreshGeminiWebAccountModels(accountId)
                          : isQoder
                            ? await window.api.gateway.refreshQoderAccountModels(accountId)
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
    [
      isKiro,
      isWindsurf,
      isTrae,
      isTraeWork,
      isWorkBuddy,
      isOpenRouter,
      isNvidia,
      isGptWeb,
      isGrokWeb,
      isQoder,
      isGeminiWeb,
      refresh,
      t,
      toast
    ]
  )

  useEffect(() => {
    if (!supportsAccounts) return
    accounts
      .filter((a) => a.enabled && !accountInfoMap[a.id])
      .forEach((acc) => fetchAccountInfo(acc.id))
  }, [accountIdsKey, accountInfoMap, accounts, fetchAccountInfo, supportsAccounts])

  useQuery({
    queryKey: ['gateway', name, 'account-usage', accountIdsKey],
    queryFn: async () => {
      await fetchAllUsage()
      return null
    },
    enabled: supportsAccounts && accounts.length > 0,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false
  })

  useEffect(() => {
    if (!supportsProxy) return
    let cancelled = false
    window.api.gateway
      .getProxyUrl()
      .then((url) => {
        if (!cancelled) setGlobalProxyUrl(url || '')
      })
      .catch(() => {
        /* benign — UI shows the "configure proxy" hint when URL stays empty */
      })
    return () => {
      cancelled = true
    }
  }, [supportsProxy])

  useEffect(() => {
    if ((!isTraeWork && !isWorkBuddy) || tab !== 'settings') return
    let cancelled = false
    const load = isTraeWork
      ? window.api.gateway.getTraeWorkSettings()
      : window.api.gateway.getWorkBuddySettings()
    load
      .then((settings) => {
        if (!cancelled) setAutoCheckin(settings?.autoCheckin !== false)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [isTraeWork, isWorkBuddy, tab])

  async function toggleAutoCheckin(): Promise<void> {
    if (checkinToggleSaving || autoCheckin === null) return
    const next = !autoCheckin
    setCheckinToggleSaving(true)
    try {
      if (isWorkBuddy) {
        await window.api.gateway.updateWorkBuddySettings({ autoCheckin: next })
      } else {
        await window.api.gateway.updateTraeWorkSettings({ autoCheckin: next })
      }
      setAutoCheckin(next)
      await refresh()
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setCheckinToggleSaving(false)
    }
  }

  async function toggleUseProxy(): Promise<void> {
    if (!gateway?.providerType || proxyToggleSaving) return
    const next = !gateway.useProxy
    setProxyToggleSaving(true)
    try {
      await window.api.gateway.setProviderUseProxy(gateway.providerType, next)
      await refresh()
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setProxyToggleSaving(false)
    }
  }

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
            <div key={i} className="card px-2.5 py-2 flex flex-col gap-2">
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
        <h1 className="text-[19px] font-[650] text-porcelain capitalize tracking-[-0.3px]">
          {name}
        </h1>
        <Button
          className="ml-auto"
          variant="ghost"
          size="sm"
          onClick={() => navigate(`/playground?provider=${encodeURIComponent(name ?? '')}`)}
          disabled={!gateway?.enabled || (gateway?.models ?? []).length === 0}
          icon={<span className="i-ph-paper-plane-tilt text-[13px]" aria-hidden="true" />}
        >
          {t('gateway.testInPlayground')}
        </Button>
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
              <span className="i-ph-pencil-simple text-[13px]" aria-hidden="true" />
            </button>
          </TooltipWrapper>
        )}
      </div>

      <SegmentedControl
        value={tab}
        onValueChange={(v) => setTab(v as 'overview' | 'settings' | 'usage')}
        items={[
          { value: 'overview', label: t('gateway.tabOverview') },
          { value: 'settings', label: t('gateway.tabSettings') },
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
      ) : tab === 'settings' ? (
        <>
          {supportsProxy && (
            <div className="card">
              <div className="flex items-center justify-between px-3.5 py-2.5">
                <div className="min-w-0">
                  <h2
                    id="gateway-use-proxy-label"
                    className="text-[13px] font-medium text-porcelain"
                  >
                    {t('gateway.proxy')}
                  </h2>
                  <p className="text-[12px] text-fog mt-0.5">{t('gateway.proxyDesc')}</p>
                  {!globalProxyUrl && (
                    <p className="text-[12px] text-warning mt-1">{t('gateway.proxyEmpty')}</p>
                  )}
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={!!gateway.useProxy}
                  aria-labelledby="gateway-use-proxy-label"
                  disabled={proxyToggleSaving || busy || !globalProxyUrl}
                  className="outline-none focus-visible:ring-1 focus-visible:ring-accent/40 disabled:opacity-40 shrink-0"
                  onClick={toggleUseProxy}
                >
                  <div
                    className={`relative w-8 h-[18px] rounded-full transition-colors duration-200 ${gateway.useProxy ? 'bg-emerald' : 'bg-charcoal border border-ash/60'}`}
                  >
                    <div
                      className={`absolute top-[3px] w-3 h-3 rounded-full transition-[left,background-color] duration-200 shadow-sm ${gateway.useProxy ? 'left-[17px] bg-white' : 'left-[3px] bg-fog'}`}
                    />
                  </div>
                </button>
              </div>
            </div>
          )}

          {(isTraeWork || isWorkBuddy) && (
            <div className="card">
              <div className="flex items-center justify-between px-3.5 py-2.5">
                <div className="min-w-0">
                  <h2
                    id="gateway-auto-checkin-label"
                    className="text-[13px] font-medium text-porcelain"
                  >
                    {t('gateway.autoCheckin')}
                  </h2>
                  <p className="text-[12px] text-fog mt-0.5">{t('gateway.autoCheckinDesc')}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoCheckin === true}
                  aria-labelledby="gateway-auto-checkin-label"
                  disabled={checkinToggleSaving || busy || autoCheckin === null}
                  className="outline-none focus-visible:ring-1 focus-visible:ring-accent/40 disabled:opacity-40 shrink-0"
                  onClick={toggleAutoCheckin}
                >
                  <div
                    className={`relative w-8 h-[18px] rounded-full transition-colors duration-200 ${autoCheckin ? 'bg-emerald' : 'bg-charcoal border border-ash/60'}`}
                  >
                    <div
                      className={`absolute top-[3px] w-3 h-3 rounded-full transition-[left,background-color] duration-200 shadow-sm ${autoCheckin ? 'left-[17px] bg-white' : 'left-[3px] bg-fog'}`}
                    />
                  </div>
                </button>
              </div>
            </div>
          )}

          {isWindsurf && <WindsurfProviderSettings />}

          {!supportsProxy && !isWindsurf && (
            <div className="card px-4 py-10 flex flex-col items-center gap-3">
              <span className="i-ph-gear text-[28px] text-charcoal" aria-hidden="true" />
              <span className="text-fog text-[13px]">{t('gateway.noSettings')}</span>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <div className="stat-card">
              <span className="label">{t('gateway.healthy')}</span>
              <span
                className={`block mt-1 font-mono text-[18px] tabular-nums leading-none ${accountStats.problematic > 0 ? 'text-warning' : 'text-porcelain'}`}
              >
                {accountStats.healthy}
                <span className="text-[12px] text-fog"> / {accountStats.total}</span>
              </span>
            </div>
            <div className="stat-card">
              <span className="label">{t('gateway.requests')}</span>
              <span className="block mt-1 font-mono text-[18px] text-porcelain tabular-nums leading-none">
                {accountStats.totalReqs}
              </span>
            </div>
            <div className="stat-card">
              <span className="label">{t('gateway.successRate')}</span>
              <span
                className={`block mt-1 font-mono text-[18px] tabular-nums leading-none ${accountStats.problematic > 0 ? 'text-warning' : 'text-porcelain'}`}
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
                              : isTraeWork
                                ? window.api.gateway.toggleTraeWorkAccount(acc.id, !acc.enabled)
                                : isWorkBuddy
                                  ? window.api.gateway.toggleWorkBuddyAccount(acc.id, !acc.enabled)
                                  : isOpenRouter
                                    ? window.api.gateway.toggleOpenRouterAccount(
                                        acc.id,
                                        !acc.enabled
                                      )
                                    : isNvidia
                                      ? window.api.gateway.toggleNvidiaAccount(acc.id, !acc.enabled)
                                      : isGptWeb
                                        ? window.api.gateway.toggleGptWebAccount(
                                            acc.id,
                                            !acc.enabled
                                          )
                                        : isGrokWeb
                                          ? window.api.gateway.toggleGrokWebAccount(
                                              acc.id,
                                              !acc.enabled
                                            )
                                          : isGeminiWeb
                                            ? window.api.gateway.toggleGeminiWebAccount(
                                                acc.id,
                                                !acc.enabled
                                              )
                                            : isQoder
                                              ? window.api.gateway.toggleQoderAccount(
                                                  acc.id,
                                                  !acc.enabled
                                                )
                                              : window.api.gateway.toggleKiroAccount(
                                                  acc.id,
                                                  !acc.enabled
                                                ),
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
                              : isTraeWork
                                ? window.api.gateway.resetTraeWorkAccount(acc.id)
                                : isWorkBuddy
                                  ? window.api.gateway.resetWorkBuddyAccount(acc.id)
                                  : isOpenRouter
                                    ? window.api.gateway.resetOpenRouterAccount(acc.id)
                                    : isNvidia
                                      ? window.api.gateway.resetNvidiaAccount(acc.id)
                                      : isGptWeb
                                        ? window.api.gateway.resetGptWebAccount(acc.id)
                                        : isGrokWeb
                                          ? window.api.gateway.resetGrokWebAccount(acc.id)
                                          : isGeminiWeb
                                            ? window.api.gateway.resetGeminiWebAccount(acc.id)
                                            : isQoder
                                              ? window.api.gateway.resetQoderAccount(acc.id)
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
                              : isTraeWork
                                ? window.api.gateway.setTraeWorkAccountStatus(
                                    acc.id,
                                    isPaused ? 'available' : 'manual_disabled'
                                  )
                                : isWorkBuddy
                                  ? window.api.gateway.setWorkBuddyAccountStatus(
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
                                          : isGeminiWeb
                                            ? window.api.gateway.setGeminiWebAccountStatus(
                                                acc.id,
                                                isPaused ? 'available' : 'manual_disabled'
                                              )
                                            : isQoder
                                              ? window.api.gateway.setQoderAccountStatus(
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
                  onCheckin={
                    isTraeWork
                      ? () =>
                          run(
                            () => window.api.gateway.checkinTraeWorkAccounts(acc.id),
                            t('gateway.checkinDone')
                          )
                      : isWorkBuddy
                        ? () =>
                            run(
                              () => window.api.gateway.checkinWorkBuddyAccounts(acc.id),
                              t('gateway.checkinDone')
                            )
                        : undefined
                  }
                  onRefreshInfo={() => fetchAccountInfo(acc.id)}
                  onRefreshModels={
                    isKiro ||
                    isWindsurf ||
                    isTrae ||
                    isTraeWork ||
                    isWorkBuddy ||
                    isOpenRouter ||
                    isNvidia ||
                    isGptWeb ||
                    isGrokWeb ||
                    isQoder ||
                    isGeminiWeb
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

      {isTraeWork && (
        <AddTraeWorkAccountDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onImported={refresh}
        />
      )}

      {isWorkBuddy && (
        <AddWorkBuddyAccountDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onImported={refresh}
        />
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

      {isGeminiWeb && (
        <AddGeminiWebAccountDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onImported={refresh}
        />
      )}

      {isQoder && (
        <AddQoderAccountDialog
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
                      : isTraeWork
                        ? window.api.gateway.removeTraeWorkAccount(removeTarget.id)
                        : isWorkBuddy
                          ? window.api.gateway.removeWorkBuddyAccount(removeTarget.id)
                          : isOpenRouter
                            ? window.api.gateway.removeOpenRouterAccount(removeTarget.id)
                            : isNvidia
                              ? window.api.gateway.removeNvidiaAccount(removeTarget.id)
                              : isGptWeb
                                ? window.api.gateway.removeGptWebAccount(removeTarget.id)
                                : isGrokWeb
                                  ? window.api.gateway.removeGrokWebAccount(removeTarget.id)
                                  : isGeminiWeb
                                    ? window.api.gateway.removeGeminiWebAccount(removeTarget.id)
                                    : isQoder
                                      ? window.api.gateway.removeQoderAccount(removeTarget.id)
                                      : window.api.gateway.removeKiroAccount(removeTarget.id),
              t('gateway.removed')
            ).then(() => setRemoveTarget(null))
          }
        }}
      />
    </div>
  )
}
