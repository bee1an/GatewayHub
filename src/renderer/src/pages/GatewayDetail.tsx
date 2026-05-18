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
  server: { running: boolean; url: string; host: string; port: number; apiKey: string }
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
  const [editingRouteName, setEditingRouteName] = useState(false)
  const [routeNameDraft, setRouteNameDraft] = useState('')
  const [removeTarget, setRemoveTarget] = useState<{ id: string; label: string } | null>(null)

  const gateway = useMemo(() => status?.providers.find((p) => p.name === name), [status, name])
  const accounts = useMemo<Account[]>(() => gateway?.accounts ?? [], [gateway?.accounts])
  const isKiro = gateway?.providerType === 'kiro'
  const accountIdsKey = useMemo(() => accounts.map((a) => a.id).join(','), [accounts])

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
      <div className="flex items-center justify-center h-64 text-storm text-[13px]">
        {status ? t('gateway.notFound', { name }) : t('common.loading')}
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {editingRouteName ? (
            <form
              className="flex items-center gap-1.5"
              onSubmit={async (e) => {
                e.preventDefault()
                const val = routeNameDraft
                  .trim()
                  .toLowerCase()
                  .replace(/[^a-z0-9_-]/g, '')
                if (val && val !== name) {
                  await run(() => window.api.gateway.updateKiroRouteName(val), t('settings.saved'))
                  window.location.hash = `#/gateway/${val}`
                }
                setEditingRouteName(false)
              }}
            >
              <input
                autoFocus
                className="input-base text-[15px] font-[590] w-32 !py-0.5 !px-1.5"
                value={routeNameDraft}
                onChange={(e) => setRouteNameDraft(e.target.value)}
                onBlur={() => setEditingRouteName(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditingRouteName(false)
                }}
              />
            </form>
          ) : (
            <h1
              className="text-[17px] font-[590] text-porcelain capitalize tracking-[-0.15px] cursor-pointer hover:text-storm"
              onClick={() => {
                if (isKiro) {
                  setRouteNameDraft(name || '')
                  setEditingRouteName(true)
                }
              }}
              title={isKiro ? t('gateway.routePrefix') : undefined}
            >
              {name}
            </h1>
          )}
          <StatusBadge status={gateway.status} />
        </div>
        <div className="flex gap-2">
          {isKiro && (
            <Button variant="primary" onClick={() => setDialogOpen(true)}>
              {t('gateway.addAccount')}
            </Button>
          )}
        </div>
      </div>

      {accounts.length === 0 ? (
        <div className="card px-4 py-10 text-center text-fog text-[13px]">
          {t('gateway.noAccounts')}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
          {accounts.map((acc) => (
            <AccountCard
              key={acc.id}
              account={acc}
              info={accountInfoMap[acc.id]}
              busy={busy}
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

function AccountCard({
  account: acc,
  info,
  busy,
  onToggle,
  onRemove,
  onReset,
  onPauseToggle,
  onRefreshInfo
}: {
  account: Account
  info?: { data?: AccountInfo; loading: boolean; error?: string }
  busy: boolean
  onToggle: () => void
  onRemove: () => void
  onReset: () => void
  onPauseToggle: () => void
  onRefreshInfo: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [detailsExpanded, setDetailsExpanded] = useState(false)
  const [modelsExpanded, setModelsExpanded] = useState(false)
  const status: AccountStatus = acc.status ?? 'available'
  const isPaused = status === 'manual_disabled'
  const isOffline = !acc.enabled || status !== 'available'
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
    ? Math.min(
        100,
        Math.round((accountInfo.usage.used / Math.max(1, accountInfo.usage.limit)) * 100)
      )
    : null
  const hasOverage = (accountInfo?.usage?.overages ?? 0) > 0

  const cooldownRemaining =
    acc.cooldownUntil && acc.cooldownUntil > now ? acc.cooldownUntil - now : null
  const statusTooltip = [
    acc.statusReason,
    cooldownRemaining
      ? t('gateway.cooldownRemaining', { duration: formatDuration(cooldownRemaining) })
      : ''
  ]
    .filter(Boolean)
    .join(' · ')

  const hasDetails =
    Boolean(accountInfo?.usage?.resetDate) ||
    Boolean(expiresAt) ||
    rate !== null ||
    hasOverage ||
    Boolean(accountInfo?.models?.length)

  return (
    <div className={`card px-3 py-2 relative overflow-hidden ${!acc.enabled ? 'opacity-60' : ''}`}>
      {acc.enabled && isOffline && (
        <div className="absolute inset-0 bg-pitch/40 pointer-events-none" />
      )}

      <div className="relative space-y-2">
        {/* 行 1：身份 + 状态 + 操作 */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={dotClass} />
            <span className="text-[13px] font-[510] text-porcelain truncate">
              {accountInfo?.email || acc.label || acc.id}
            </span>
            {accountInfo?.subscription && accountInfo.subscription.type !== 'unknown' && (
              <span className="tag text-[12px] !px-1 !py-0 text-lime">
                {accountInfo.subscription.title}
              </span>
            )}
            <TooltipWrapper content={statusTooltip || t(`gateway.${statusVisual.i18nKey}`)}>
              <span className={`${statusVisual.badgeClass} !px-1 !py-0`}>
                {t(`gateway.${statusVisual.i18nKey}`)}
                {cooldownRemaining && (
                  <span className="ml-1 font-mono">{formatDuration(cooldownRemaining)}</span>
                )}
              </span>
            </TooltipWrapper>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <TooltipWrapper content={t('gateway.refresh')}>
              <Button
                variant="ghost"
                size="xs"
                iconOnly
                onClick={onRefreshInfo}
                disabled={info?.loading}
              >
                ↻
              </Button>
            </TooltipWrapper>
            {acc.failures > 0 && (
              <Button size="xs" disabled={busy} onClick={onReset}>
                {t('gateway.reset')}
              </Button>
            )}
            {acc.enabled && (
              <Button size="xs" disabled={busy} onClick={onPauseToggle}>
                {isPaused ? t('gateway.resume') : t('gateway.pause')}
              </Button>
            )}
            <Button size="xs" disabled={busy} onClick={onToggle}>
              {acc.enabled ? t('gateway.disable') : t('gateway.enable')}
            </Button>
            <Button variant="danger" size="xs" disabled={busy} onClick={onRemove}>
              {t('gateway.remove')}
            </Button>
          </div>
        </div>

        {/* 行 2：用量进度条（如有） */}
        {accountInfo?.usage && (
          <div className="flex items-center gap-2 text-[12px]">
            <div className="flex-1 h-1 rounded-full bg-charcoal overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${hasOverage ? 'bg-red' : usagePercent! > 80 ? 'bg-warning' : 'bg-emerald'}`}
                style={{ width: `${Math.min(usagePercent!, 100)}%` }}
              />
            </div>
            <span className={`font-mono shrink-0 ${hasOverage ? 'text-red' : 'text-storm'}`}>
              {accountInfo.usage.used}/{accountInfo.usage.limit}
            </span>
          </div>
        )}

        {/* 行 3：异常状态提示常显 */}
        {info?.loading && !accountInfo && (
          <span className="text-[12px] text-fog block">{t('gateway.loadingInfo')}</span>
        )}
        {(info?.error || accountInfo?.error) && (
          <p
            className="text-[12px] text-red truncate"
            title={info?.error || accountInfo?.error}
          >
            {info?.error || accountInfo?.error}
          </p>
        )}
        {acc.lastError && (
          <p className="text-[12px] text-red truncate" title={acc.lastError}>
            {acc.lastError}
          </p>
        )}

        {/* 行 4：折叠的详情区 */}
        {hasDetails && (
          <div>
            <button
              className="text-[12px] text-fog hover:text-storm flex items-center gap-1"
              onClick={() => setDetailsExpanded(!detailsExpanded)}
            >
              <span>{detailsExpanded ? '▾' : '▸'}</span>
              <span>{t('gateway.details')}</span>
            </button>
            {detailsExpanded && (
              <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
                {rate !== null && (
                  <>
                    <dt className="text-fog">{t('gateway.successRate')}</dt>
                    <dd className={`font-mono ${statusVisual.rateColorClass}`}>
                      {rate}% ({success}/{total})
                    </dd>
                  </>
                )}
                {accountInfo?.usage?.resetDate && (
                  <>
                    <dt className="text-fog">{t('gateway.resetDate')}</dt>
                    <dd className="font-mono text-storm">
                      {formatResetDate(accountInfo.usage.resetDate)}
                    </dd>
                  </>
                )}
                {expiresAt && (
                  <>
                    <dt className="text-fog">{t('gateway.expires')}</dt>
                    <dd className={`font-mono ${expiryUrgent ? 'text-red' : 'text-storm'}`}>
                      {formatDuration(expiresIn!)}
                    </dd>
                  </>
                )}
                {hasOverage && accountInfo?.usage && (
                  <>
                    <dt className="text-fog">{t('gateway.overages')}</dt>
                    <dd className="font-mono text-red">
                      +{accountInfo.usage.overages} (${accountInfo.usage.overageCharges.toFixed(2)})
                    </dd>
                  </>
                )}
                {accountInfo?.models && accountInfo.models.length > 0 && (
                  <>
                    <dt className="text-fog">{t('gateway.models')}</dt>
                    <dd>
                      <button
                        className="text-storm hover:text-porcelain inline-flex items-center gap-1"
                        onClick={() => setModelsExpanded(!modelsExpanded)}
                      >
                        <span>{accountInfo.models.length}</span>
                        <span>{modelsExpanded ? '▾' : '▸'}</span>
                      </button>
                      {modelsExpanded && (
                        <div className="flex flex-wrap gap-0.5 mt-1">
                          {accountInfo.models.map((m) => (
                            <span
                              key={m.modelId}
                              className="tag text-[12px] font-mono !px-1 !py-0"
                            >
                              {m.modelName || m.modelId}
                              {m.rateMultiplier > 1 && (
                                <span className="ml-0.5 text-warning">{m.rateMultiplier}x</span>
                              )}
                            </span>
                          ))}
                        </div>
                      )}
                    </dd>
                  </>
                )}
              </dl>
            )}
          </div>
        )}
      </div>
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
                          className={`flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-sm)] ${c.existing ? 'opacity-40 cursor-not-allowed' : 'hover:bg-slate/30 cursor-pointer'}`}
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
                            className="accent-lime"
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

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  const color =
    status === 'ready' || status === 'running'
      ? 'text-emerald'
      : status === 'error'
        ? 'text-red'
        : 'text-fog'
  return (
    <span className={`badge ${color}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${color.replace('text-', 'bg-')}`} />
      {status}
    </span>
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
