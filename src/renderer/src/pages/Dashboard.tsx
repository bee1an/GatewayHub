import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router-dom'
import { usePolling } from '../hooks/usePolling'
import { ProviderLogo } from '../components/ProviderLogo'
import { getProviderLogoLabel } from '../components/providerLogoData'
import { useTheme } from '../components/useTheme'

type ProviderStatus = {
  name: string
  providerType: string
  displayName?: string
  enabled: boolean
  configured: boolean
  status: string
  models: string[]
}

type GatewayStatus = {
  server: { running: boolean; url: string }
  providers: ProviderStatus[]
  logs: Array<{ ts: number; level: string; message: string }>
}

export default function Dashboard(): React.JSX.Element {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const { data: status } = usePolling<GatewayStatus>(() => window.api.gateway.status(), 5000)

  if (!status) return <DashboardSkeleton />

  // Show every real provider (enabled or not) so the dashboard is a complete
  // roster; placeholder slots are hidden. Disabled ones read as a muted row.
  const providers = status.providers?.filter((p) => p.status !== 'placeholder') ?? []

  return (
    <div className="flex flex-col gap-5 animate-fade-in">
      <div>
        <h1 className="section-title">{t('dashboard.title')}</h1>
        <p className="section-desc">{t('dashboard.desc')}</p>
      </div>

      {providers.length === 0 ? (
        <div className="card px-3.5 py-4">
          <p className="text-[12px] text-fog text-center">{t('dashboard.empty')}</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          {providers.map((p, i) => {
            const label = getProviderLogoLabel(p.providerType, p.displayName)
            const ready = p.status === 'ready'
            const errored = p.status === 'error'
            const dim = !p.enabled
            return (
              <NavLink
                key={p.name}
                to={`/gateway/${p.name}`}
                className={`flex items-center gap-3 px-3 py-2 transition-colors hover:bg-charcoal/40 ${i > 0 ? 'border-t border-charcoal/40' : ''} ${dim ? 'opacity-50' : ''}`}
              >
                <ProviderLogo providerType={p.providerType} label={label} theme={theme} size="sm" />
                <span className="text-[13px] text-porcelain font-medium flex-1 capitalize">
                  {label}
                </span>
                <span className="text-[11px] text-fog tabular-nums">
                  {p.configured
                    ? `${p.models.length} ${t('dashboard.models')}`
                    : t('dashboard.notConfigured')}
                </span>
                <span
                  className={`w-[6px] h-[6px] rounded-full ${ready ? 'bg-emerald' : errored ? 'bg-red' : 'bg-fog'}`}
                  aria-hidden="true"
                />
                <span
                  className={`text-[10px] font-medium uppercase tracking-[0.3px] ${ready ? 'text-emerald' : errored ? 'text-red' : 'text-fog'}`}
                >
                  {p.status}
                </span>
              </NavLink>
            )
          })}
        </div>
      )}
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
      <div className="card overflow-hidden">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className={`flex items-center gap-3 px-3 py-2 ${i > 0 ? 'border-t border-charcoal/40' : ''}`}
          >
            <div className="w-4 h-4 rounded bg-charcoal/80 animate-pulse" />
            <div className="h-[13px] w-[80px] rounded bg-charcoal/70 animate-pulse flex-1" />
            <div className="h-[11px] w-[50px] rounded bg-charcoal/50 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  )
}
