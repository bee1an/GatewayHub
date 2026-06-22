import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { usePolling } from '../hooks/usePolling'
import { Button } from '../components/ui/Button'
import { useToast } from '../components/ui/ToastContext'

type ApiKeyEntry = {
  id: string
  key: string
  name: string
  createdAt: number
  lastUsedAt?: number
  expiresAt?: number
  scopes?: string[]
}

type ProviderStatus = {
  name: string
  providerType: string
  displayName?: string
  enabled: boolean
  configured: boolean
  status: string
  models: string[]
}

type LogEntry = {
  ts: number
  level: string
  message: string
  provider?: string
  category?: string
  statusCode?: number
}

type GatewayStatus = {
  server: { running: boolean; url: string; host: string; port: number; apiKeys: ApiKeyEntry[] }
  providers: ProviderStatus[]
  logs: LogEntry[]
}

const RECENT_ERROR_LIMIT = 5

export default function Dashboard(): React.JSX.Element {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { data: status, refresh } = usePolling<GatewayStatus>(
    () => window.api.gateway.status(),
    5000
  )
  const [toggling, setToggling] = useState(false)

  const errorLogs = useMemo(
    () =>
      (status?.logs ?? [])
        .filter((l) => l.level === 'error')
        .slice(-RECENT_ERROR_LIMIT)
        .reverse(),
    [status?.logs]
  )
  const totalErrors = useMemo(
    () => (status?.logs ?? []).filter((l) => l.level === 'error').length,
    [status?.logs]
  )

  if (!status) return <DashboardSkeleton />

  const running = status.server.running
  const providers = status.providers?.filter((p) => p.status !== 'placeholder') ?? []
  const readyCount = providers.filter((p) => p.enabled && p.status === 'ready').length

  async function handleToggle(): Promise<void> {
    const wasRunning = running
    setToggling(true)
    try {
      const result = (await (wasRunning
        ? window.api.gateway.stop()
        : window.api.gateway.start())) as { ok?: boolean; error?: string; code?: string }
      if (result?.ok === false) {
        const err = new Error(
          result.error || (wasRunning ? t('sidebar.stopFailed') : t('sidebar.startFailed'))
        )
        ;(err as Error & { code?: string }).code = result.code
        throw err
      }
      refresh()
    } catch (err) {
      refresh()
      const raw = (err as Error)?.message ?? String(err)
      const portMatch = raw.match(/(?:port|端口)\s*(\d+)/i)
      const port = portMatch?.[1]
      const code = (err as Error & { code?: string })?.code
        ? (err as Error & { code?: string }).code
        : /EADDRINUSE/.test(raw) || /already in use/i.test(raw)
          ? 'EADDRINUSE'
          : /EACCES/.test(raw)
            ? 'EACCES'
            : /EADDRNOTAVAIL/.test(raw)
              ? 'EADDRNOTAVAIL'
              : null
      const localized = code
        ? t(`sidebar.serverError.${code}`, { defaultValue: raw, port: port ?? '?' })
        : raw
      const prefix = wasRunning ? t('sidebar.stopFailed') : t('sidebar.startFailed')
      toast(`${prefix}: ${localized}`, 'error')
    } finally {
      setToggling(false)
    }
  }

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <div>
        <h1 className="section-title">{t('dashboard.title')}</h1>
        <p className="section-desc">{t('dashboard.desc')}</p>
      </div>

      {/* ① 网关控制条 */}
      <GatewayControlBar
        running={running}
        url={status.server.url}
        readyCount={readyCount}
        totalCount={providers.length}
        errorCount={totalErrors}
        toggling={toggling}
        onToggle={handleToggle}
      />

      {/* ② 最近异常 */}
      <RecentErrors errors={errorLogs} />
    </div>
  )
}

function GatewayControlBar({
  running,
  url,
  readyCount,
  totalCount,
  errorCount,
  toggling,
  onToggle
}: {
  running: boolean
  url: string
  readyCount: number
  totalCount: number
  errorCount: number
  toggling: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="card px-4 py-3.5 flex items-center justify-between gap-4 flex-wrap">
      <div className="flex items-center gap-3.5">
        <div
          className={`relative w-2.5 h-2.5 rounded-full ${running ? 'bg-emerald' : 'bg-fog'} ${running ? 'shadow-[var(--shadow-glow-emerald)]' : ''}`}
          aria-hidden="true"
        />
        <div className="flex flex-col gap-0.5">
          <span className={`text-[14px] font-[590] ${running ? 'text-emerald' : 'text-storm'}`}>
            {running ? t('dashboard.running') : t('dashboard.stopped')}
          </span>
          <span className="text-[11px] text-fog font-mono">{url}</span>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Link
          to="/logs"
          className="flex flex-col items-end gap-0.5 px-2.5 py-1 rounded-[var(--radius-sm)] hover:bg-charcoal/50 transition-colors"
        >
          <span className="text-[12px] text-storm tabular-nums">
            {t('dashboard.providersReady', { ready: readyCount, total: totalCount })}
          </span>
          <span className={`text-[11px] tabular-nums ${errorCount > 0 ? 'text-red' : 'text-fog'}`}>
            {t('dashboard.errors', { count: errorCount })}
          </span>
        </Link>
        <Button
          variant={running ? 'danger' : 'primary'}
          size="lg"
          loading={toggling}
          onClick={onToggle}
          icon={
            <span
              className={running ? 'i-ph-stop text-[14px]' : 'i-ph-play text-[14px]'}
              aria-hidden="true"
            />
          }
        >
          {running ? t('dashboard.stop') : t('dashboard.start')}
        </Button>
      </div>
    </div>
  )
}

function RecentErrors({ errors }: { errors: LogEntry[] }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="card px-4 py-3.5 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-[590] text-porcelain">{t('dashboard.recentErrors')}</span>
        <Link to="/logs" className="text-[11px] text-storm hover:text-porcelain transition-colors">
          {t('dashboard.viewAll')} →
        </Link>
      </div>
      {errors.length === 0 ? (
        <p className="text-[12px] text-fog py-2 text-center">{t('dashboard.noErrors')}</p>
      ) : (
        <div className="flex flex-col">
          {errors.map((log, i) => (
            <div
              key={`${log.ts}-${i}`}
              className={`flex items-start gap-2.5 px-1 py-1.5 ${i > 0 ? 'border-t border-charcoal/40' : ''}`}
            >
              <time className="shrink-0 text-[11px] font-mono text-fog tabular-nums w-[56px]">
                {new Date(log.ts).toLocaleTimeString('en-GB', {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit'
                })}
              </time>
              {log.provider && (
                <span className="shrink-0 text-[11px] text-storm font-medium w-[80px] truncate">
                  {log.provider}
                </span>
              )}
              <p
                className="text-[11px] text-porcelain/85 truncate flex-1 min-w-0"
                title={log.message}
              >
                {log.message}
              </p>
              {log.statusCode && (
                <span className="shrink-0 text-[10px] text-red font-mono tabular-nums">
                  {log.statusCode}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function DashboardSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <div className="h-[16px] w-[100px] rounded bg-charcoal/80 animate-pulse" />
        <div className="h-[13px] w-[160px] rounded bg-charcoal/50 animate-pulse" />
      </div>
      <div className="card px-4 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-3.5">
          <div className="w-2.5 h-2.5 rounded-full bg-charcoal/80 animate-pulse" />
          <div className="flex flex-col gap-1">
            <div className="h-[14px] w-[70px] rounded bg-charcoal/80 animate-pulse" />
            <div className="h-[11px] w-[120px] rounded bg-charcoal/50 animate-pulse" />
          </div>
        </div>
        <div className="h-9 w-24 rounded-[var(--radius-md)] bg-charcoal/80 animate-pulse" />
      </div>
      <div className="card px-4 py-3.5 flex flex-col gap-2">
        <div className="h-[13px] w-[90px] rounded bg-charcoal/80 animate-pulse" />
        <div className="h-10 rounded bg-charcoal/50 animate-pulse" />
      </div>
    </div>
  )
}
