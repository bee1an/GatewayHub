import { NavLink } from 'react-router-dom'
import { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useTheme } from './useTheme'
import { changeLanguage } from '../i18n'
import { Button } from './ui/Button'
import { TooltipWrapper } from './ui/Tooltip'
import kiroIcon from '../assets/kiro-icon.svg'

type ProviderStatus = {
  name: string
  providerType: string
  enabled: boolean
  configured: boolean
  status: string
  message?: string
  models: string[]
}

type ServerInfo = {
  running: boolean
}

const GATEWAY_LOGOS: Record<string, string> = {
  kiro: kiroIcon
}

const PLACEHOLDER_PROVIDERS = ['codex', 'gemini']

export default function Sidebar(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { theme, toggle } = useTheme()
  const [gateways, setGateways] = useState<ProviderStatus[]>([])
  const [server, setServer] = useState<ServerInfo>({ running: false })

  const refresh = useCallback(() => {
    window.api.gateway.status().then((s: any) => {
      setGateways(s.providers ?? [])
      setServer({ running: s.server?.running ?? false })
    })
  }, [])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 5000)
    return () => clearInterval(interval)
  }, [refresh])

  const configuredGateways = gateways.filter((p) => p.enabled && p.configured)

  function toggleLang(): void {
    changeLanguage(i18n.language === 'zh' ? 'en' : 'zh')
  }

  return (
    <aside className="w-[200px] shrink-0 flex flex-col border-r border-charcoal bg-graphite overflow-y-auto select-none">
      <div className="h-10 flex items-center pl-[78px] pr-4 shrink-0 [-webkit-app-region:drag]">
        <span className="text-[13px] font-[590] text-porcelain tracking-[-0.15px]">GatewayHub</span>
      </div>

      <nav className="flex-1 flex flex-col px-2 py-2 gap-0.5">
        <NavLink
          to="/dashboard"
          className={({ isActive }) => (isActive ? 'sidebar-item-active' : 'sidebar-item')}
        >
          <span className="i-ph-gauge text-[16px]" />
          <span>{t('sidebar.dashboard')}</span>
        </NavLink>

        <div className="mt-3 mb-1 px-3">
          <span className="label">{t('sidebar.gateways')}</span>
        </div>

        {configuredGateways.map((gw) => (
          <GatewayNavItem
            key={gw.name}
            name={gw.name}
            providerType={gw.providerType}
            status={gw.status}
          />
        ))}

        {PLACEHOLDER_PROVIDERS.filter((n) => !configuredGateways.some((g) => g.name === n)).map(
          (name) => (
            <div key={name} className="sidebar-item opacity-40 cursor-default">
              <span className="pulse-dot-gray" />
              <span className="capitalize">{name}</span>
              <span className="ml-auto text-[12px] text-fog">{t('sidebar.soon')}</span>
            </div>
          )
        )}

        <div className="mt-3 mb-1 px-3">
          <span className="label">{t('sidebar.system')}</span>
        </div>

        <NavLink
          to="/logs"
          className={({ isActive }) => (isActive ? 'sidebar-item-active' : 'sidebar-item')}
        >
          <span className="i-ph-list-bullets text-[16px]" />
          <span>{t('sidebar.logs')}</span>
        </NavLink>

        <NavLink
          to="/settings"
          className={({ isActive }) => (isActive ? 'sidebar-item-active' : 'sidebar-item')}
        >
          <span className="i-ph-gear text-[16px]" />
          <span>{t('sidebar.settings')}</span>
        </NavLink>
      </nav>

      <div className="shrink-0 px-2 py-2 border-t border-charcoal flex items-center justify-between">
        <div className="flex items-center gap-2 px-2">
          <span className={server.running ? 'pulse-dot-green' : 'pulse-dot-gray'} />
          <span className="text-[12px] text-fog">
            {server.running ? t('sidebar.running') : t('sidebar.stopped')}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <TooltipWrapper content={t('sidebar.toggleLang')}>
            <Button variant="ghost" size="xs" onClick={toggleLang} aria-label="Toggle language">
              {i18n.language === 'zh' ? 'EN' : '中'}
            </Button>
          </TooltipWrapper>
          <TooltipWrapper content={t('sidebar.toggleTheme')}>
            <Button variant="ghost" size="xs" iconOnly onClick={toggle} aria-label="Toggle theme">
              {theme === 'dark' ? '☀' : '●'}
            </Button>
          </TooltipWrapper>
        </div>
      </div>
    </aside>
  )
}

function GatewayNavItem({
  name,
  providerType,
  status
}: {
  name: string
  providerType: string
  status: string
}): React.JSX.Element {
  const dotClass =
    status === 'ready' || status === 'running'
      ? 'pulse-dot-green'
      : status === 'error'
        ? 'pulse-dot-red'
        : 'pulse-dot-gray'
  const logo = GATEWAY_LOGOS[providerType]

  return (
    <NavLink
      to={`/gateway/${name}`}
      className={({ isActive }) => (isActive ? 'sidebar-item-active' : 'sidebar-item')}
    >
      {logo ? (
        <img src={logo} alt={name} className="w-4 h-4 rounded-[2px] object-contain" />
      ) : (
        <span className={dotClass} />
      )}
      <span className="capitalize">{name}</span>
      {logo && <span className={`ml-auto ${dotClass}`} />}
    </NavLink>
  )
}
