import { Outlet, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import Sidebar from './Sidebar'

function StatusStrip(): React.JSX.Element {
  const { t } = useTranslation()
  const { data } = useQuery({
    queryKey: ['gateway', 'status'],
    queryFn: () => window.api.gateway.status(),
    refetchInterval: 5000,
    refetchIntervalInBackground: false
  })
  const running = data?.server?.running ?? false
  const providers = (data?.providers ?? []).filter((p: any) => p.enabled)
  const ready = providers.filter((p: any) => p.status === 'ready').length
  const errors = (data?.logs ?? []).filter((l: any) => l.level === 'error').length

  return (
    <div className="h-10 shrink-0 flex items-center gap-4 px-5 border-b border-[var(--glass-border)] [-webkit-app-region:drag] select-none">
      <span
        className={`font-mono text-[10px] font-semibold uppercase tracking-[0.12em] ${running ? 'text-accent' : 'text-fog'}`}
      >
        {running ? `● ${t('dashboard.running')}` : `○ ${t('dashboard.stopped')}`}
      </span>
      <span className="font-mono text-[10px] text-fog tabular-nums">
        {data?.server?.url ?? '—'}
      </span>
      <span className="flex-1" />
      <span className="font-mono text-[10px] text-fog tabular-nums">
        {ready}/{providers.length}
      </span>
      <span
        className={`font-mono text-[10px] tabular-nums ${errors > 0 ? 'text-red' : 'text-fog'}`}
      >
        {errors} err
      </span>
      <span className="font-mono text-[10px] text-fog">v{window.api.appVersion}</span>
    </div>
  )
}

export default function Layout(): React.JSX.Element {
  const location = useLocation()
  const isGatewayRoute = location.pathname.startsWith('/gateway/')

  return (
    <div className="h-full flex justify-center">
      <div className="app-shell h-full w-full max-w-[1500px] flex gap-3 p-3">
        <Sidebar />
        <div className="relative flex-1 flex flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--glass-border-strong)] bg-[var(--pane-bg)] shadow-[var(--glass-shadow)]">
          {/* specular top edge — the 1px highlight that reads as glass */}
          <div className="pointer-events-none absolute top-0 left-0 right-0 h-px bg-[var(--glass-specular)] z-10" />
          <StatusStrip />
          <main className="app-main flex-1 overflow-y-auto">
            <div
              className={`page-col mx-auto px-6 pb-5 ${isGatewayRoute ? 'max-w-5xl' : 'max-w-4xl'}`}
              style={{ '--page-mw': isGatewayRoute ? '64rem' : '56rem' } as React.CSSProperties}
            >
              <Outlet />
            </div>
          </main>
        </div>
      </div>
    </div>
  )
}
