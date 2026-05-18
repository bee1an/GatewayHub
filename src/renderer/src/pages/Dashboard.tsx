import { useTranslation } from 'react-i18next'
import { usePolling } from '../hooks/usePolling'

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
  logs: { ts: number; level: string; message: string; provider?: string; accountId?: string }[]
}

export default function Dashboard(): React.JSX.Element {
  const { t } = useTranslation()
  const { data: status } = usePolling<GatewayStatus>(() => window.api.gateway.status(), 3000)

  if (!status) {
    return <div className="text-storm text-[13px]">{t('common.loading')}</div>
  }

  const providers = status.providers?.filter((p) => p.enabled && p.configured) ?? []
  const logs = status.logs ?? []
  const recentLogs = logs.slice(-50).reverse()

  const totalRequests = recentLogs.length
  const errorLogs = recentLogs.filter((l) => l.level === 'error')
  const successRate =
    totalRequests > 0 ? Math.round(((totalRequests - errorLogs.length) / totalRequests) * 100) : 100

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="section-title">{t('dashboard.title')}</h1>
        <p className="section-desc">{t('dashboard.desc')}</p>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <StatCard
          label={t('dashboard.server')}
          value={status.server.running ? t('sidebar.running') : t('sidebar.stopped')}
          accent={status.server.running ? 'emerald' : 'fog'}
        />
        <StatCard
          label={t('dashboard.providers')}
          value={String(providers.length)}
          accent="aether"
        />
        <StatCard
          label={t('dashboard.models')}
          value={String(providers.reduce((sum, p) => sum + p.models.length, 0))}
          accent="cyan"
        />
        <StatCard
          label={t('dashboard.successRate')}
          value={`${successRate}%`}
          accent={successRate >= 90 ? 'emerald' : successRate >= 70 ? 'warning' : 'red'}
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <span className="label">{t('dashboard.recentActivity')}</span>
          <span className="text-[12px] text-fog">
            {t('dashboard.entries', { count: recentLogs.length })}
          </span>
        </div>
        <div className="card overflow-hidden">
          {recentLogs.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-fog">
              {t('dashboard.noActivity')}
            </div>
          ) : (
            <div className="max-h-[400px] overflow-y-auto">
              {recentLogs.map((log, i) => (
                <RequestRow key={`${log.ts}-${i}`} log={log} isNew={i < 3} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function StatCard({
  label,
  value,
  accent
}: {
  label: string
  value: string
  accent: string
}): React.JSX.Element {
  return (
    <div className="stat-card-lg">
      <span className="text-[12px] text-fog uppercase tracking-[0.5px]">{label}</span>
      <span className={`text-[20px] font-[590] text-${accent} tracking-[-0.22px]`}>{value}</span>
    </div>
  )
}

function RequestRow({ log, isNew }: { log: any; isNew: boolean }): React.JSX.Element {
  const levelColor =
    log.level === 'error' ? 'bg-red' : log.level === 'warn' ? 'bg-warning' : 'bg-emerald'
  const time = new Date(log.ts).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })

  return (
    <div className={`log-row ${isNew ? 'animate-slide-up' : ''}`}>
      <span className={`w-0.5 self-stretch rounded-full ${levelColor}`} />
      <span className="text-[12px] text-fog w-[64px] shrink-0 font-mono">{time}</span>
      {log.provider && <span className="badge">{log.provider}</span>}
      <span className="text-[13px] text-steel truncate flex-1">{log.message}</span>
    </div>
  )
}
