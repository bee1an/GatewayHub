import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { usePolling } from '../hooks/usePolling'

type GatewayLogEntry = {
  ts: number
  level: string
  message: string
  provider?: string
  category?: string
  statusCode?: number
  duration?: number
  streaming?: boolean
  timeToFirstToken?: number
}

type ProviderStatus = {
  name: string
  enabled: boolean
  configured: boolean
  status: string
  models: string[]
}

type GatewayStatus = {
  server: { running: boolean; url: string }
  providers: ProviderStatus[]
  logs: GatewayLogEntry[]
}

const PROVIDER_COLORS = [
  { bg: 'bg-aether', dot: 'bg-aether' },
  { bg: 'bg-cyan', dot: 'bg-cyan' },
  { bg: 'bg-emerald', dot: 'bg-emerald' },
  { bg: 'bg-violet', dot: 'bg-violet' },
  { bg: 'bg-warning', dot: 'bg-warning' },
  { bg: 'bg-amethyst', dot: 'bg-amethyst' }
]

export default function Dashboard(): React.JSX.Element {
  const { t } = useTranslation()
  const { data: status } = usePolling<GatewayStatus>(() => window.api.gateway.status(), 3000)

  const logs = useMemo(() => status?.logs ?? [], [status?.logs])

  const metrics = useMemo(() => {
    const todayStart = new Date().setHours(0, 0, 0, 0)
    const todayLogs = logs.filter((l) => l.ts >= todayStart)
    const requestLogs = todayLogs.filter((l) => l.category === 'request')

    const todayRequests = requestLogs.length
    const todayErrors = requestLogs.filter(
      (l) => l.level === 'error' || (l.statusCode && l.statusCode >= 400)
    )
    const successRate =
      todayRequests > 0
        ? Math.round(((todayRequests - todayErrors.length) / todayRequests) * 100)
        : 100

    const durationLogs = requestLogs.filter((l) => l.duration !== undefined)
    const avgDuration =
      durationLogs.length > 0
        ? Math.round(durationLogs.reduce((s, l) => s + l.duration!, 0) / durationLogs.length)
        : null

    const ttftLogs = requestLogs.filter((l) => l.streaming && l.timeToFirstToken !== undefined)
    const avgTTFT =
      ttftLogs.length > 0
        ? Math.round(ttftLogs.reduce((s, l) => s + l.timeToFirstToken!, 0) / ttftLogs.length)
        : null

    const providerBreakdown = requestLogs.reduce(
      (acc, l) => {
        if (l.provider) acc[l.provider] = (acc[l.provider] ?? 0) + 1
        return acc
      },
      {} as Record<string, number>
    )

    return { todayRequests, successRate, avgDuration, avgTTFT, providerBreakdown }
  }, [logs])

  if (!status) return <DashboardSkeleton />

  const providers = status.providers?.filter((p) => p.enabled && p.configured) ?? []
  const allProviders = status.providers?.filter((p) => p.status !== 'placeholder') ?? []

  const successRateAccent =
    metrics.successRate >= 90 ? 'emerald' : metrics.successRate >= 70 ? 'warning' : 'red'

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <div>
        <h1 className="section-title">{t('dashboard.title')}</h1>
        <p className="section-desc">{t('dashboard.desc')}</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          icon="i-ph-power"
          label={t('dashboard.server')}
          value={status.server.running ? t('sidebar.running') : t('sidebar.stopped')}
          accent={status.server.running ? 'emerald' : 'fog'}
        />
        <StatCard
          icon="i-ph-plugs-connected"
          label={t('dashboard.providers')}
          value={`${providers.length} / ${allProviders.length}`}
          accent="aether"
        />
        <StatCard
          icon="i-ph-cube"
          label={t('dashboard.models')}
          value={String(providers.reduce((sum, p) => sum + p.models.length, 0))}
          accent="cyan"
        />
        <StatCard
          icon="i-ph-check-circle"
          label={t('dashboard.successRate')}
          value={`${metrics.successRate}%`}
          accent={successRateAccent}
        />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <MetricCard
          icon="i-ph-timer"
          label={t('dashboard.avgResponseTime')}
          value={metrics.avgDuration !== null ? String(metrics.avgDuration) : t('dashboard.noData')}
          unit={metrics.avgDuration !== null ? 'ms' : ''}
          accent="cyan"
        />
        <MetricCard
          icon="i-ph-lightning"
          label={t('dashboard.avgTTFT')}
          value={metrics.avgTTFT !== null ? String(metrics.avgTTFT) : t('dashboard.noData')}
          unit={metrics.avgTTFT !== null ? 'ms' : ''}
          accent="aether"
        />
        <MetricCard
          icon="i-ph-arrow-up-right"
          label={t('dashboard.todayRequests')}
          value={String(metrics.todayRequests)}
          unit=""
          accent="emerald"
        />
      </div>

      {Object.keys(metrics.providerBreakdown).length > 0 && (
        <ProviderBar
          breakdown={metrics.providerBreakdown}
          label={t('dashboard.providerBreakdown')}
        />
      )}

      {providers.length > 0 && (
        <div className="card overflow-hidden">
          {providers.map((p, i) => (
            <div
              key={p.name}
              className={`flex items-center gap-3 px-3 py-2 ${i > 0 ? 'border-t border-charcoal/40' : ''}`}
            >
              <span
                className={`w-[6px] h-[6px] rounded-full ${p.status === 'ready' ? 'bg-emerald animate-pulse-green' : p.status === 'error' ? 'bg-red' : 'bg-fog'}`}
              />
              <span className="text-[13px] text-porcelain font-medium flex-1">{p.name}</span>
              <span className="text-[11px] text-fog tabular-nums">{p.models.length} models</span>
              <span
                className={`text-[10px] font-medium uppercase tracking-[0.3px] ${p.status === 'ready' ? 'text-emerald' : p.status === 'error' ? 'text-red' : 'text-fog'}`}
              >
                {p.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  accent
}: {
  icon: string
  label: string
  value: string
  accent: string
}): React.JSX.Element {
  return (
    <div
      className="card px-3 py-2.5 flex flex-col gap-1.5 border-l-[2px]"
      style={{ borderLeftColor: `var(--c-${accent})` }}
    >
      <div className="flex items-center gap-1.5">
        <span className={`${icon} text-[12px] text-${accent}`} aria-hidden="true" />
        <span className="text-[10px] text-storm font-medium uppercase tracking-[0.5px]">
          {label}
        </span>
      </div>
      <span
        className={`text-[17px] font-[650] text-${accent} tracking-[-0.3px] tabular-nums leading-none`}
      >
        {value}
      </span>
    </div>
  )
}

function MetricCard({
  icon,
  label,
  value,
  unit,
  accent
}: {
  icon: string
  label: string
  value: string
  unit: string
  accent: string
}): React.JSX.Element {
  return (
    <div className="card px-3 py-2.5 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className={`${icon} text-[12px] text-${accent} opacity-60`} aria-hidden="true" />
        <span className="text-[10px] text-storm font-medium uppercase tracking-[0.5px]">
          {label}
        </span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-[17px] font-[600] text-porcelain tracking-[-0.3px] tabular-nums leading-none">
          {value}
        </span>
        {unit && <span className="text-[11px] text-fog font-medium">{unit}</span>}
      </div>
    </div>
  )
}

function ProviderBar({
  breakdown,
  label
}: {
  breakdown: Record<string, number>
  label: string
}): React.JSX.Element {
  const total = Object.values(breakdown).reduce((s, v) => s + v, 0)
  const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1])

  return (
    <div className="card px-3 py-2.5 flex flex-col gap-2">
      <span className="text-[10px] text-storm font-medium uppercase tracking-[0.5px]">{label}</span>
      <div className="flex h-[6px] rounded-full overflow-hidden bg-pitch gap-[1px]">
        {entries.map(([name, count], i) => (
          <div
            key={name}
            className={`${PROVIDER_COLORS[i % PROVIDER_COLORS.length].bg} rounded-full transition-all duration-300 first:rounded-l-full last:rounded-r-full`}
            style={{ width: `${(count / total) * 100}%`, minWidth: '4px' }}
            title={`${name}: ${count}`}
          />
        ))}
      </div>
      <div className="flex gap-3 flex-wrap">
        {entries.map(([name, count], i) => (
          <span key={name} className="flex items-center gap-1 text-[11px] text-steel">
            <span
              className={`w-[6px] h-[6px] rounded-full ${PROVIDER_COLORS[i % PROVIDER_COLORS.length].dot}`}
            />
            <span className="font-medium">{name}</span>
            <span className="text-fog tabular-nums">{count}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

function DashboardSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <div className="h-[16px] w-[100px] rounded bg-charcoal/80 animate-pulse" />
        <div className="h-[13px] w-[160px] rounded bg-charcoal/50 animate-pulse" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="card px-3 py-2.5 flex flex-col gap-2 border-l-[2px] border-l-charcoal"
          >
            <div className="h-[12px] w-[60px] rounded bg-charcoal/60 animate-pulse" />
            <div className="h-[18px] w-[44px] rounded bg-charcoal/80 animate-pulse" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="card px-3 py-2.5 flex flex-col gap-2">
            <div className="h-[12px] w-[70px] rounded bg-charcoal/60 animate-pulse" />
            <div className="h-[18px] w-[40px] rounded bg-charcoal/80 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  )
}
