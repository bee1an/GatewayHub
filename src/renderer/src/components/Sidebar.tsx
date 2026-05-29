import { NavLink } from 'react-router-dom'
import { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useTheme } from './useTheme'
import { changeLanguage } from '../i18n'
import { Button } from './ui/Button'
import { TooltipWrapper } from './ui/Tooltip'
import { useToast } from './ui/ToastContext'
import { UpdateModal } from './UpdateModal'
import kiroIcon from '../assets/kiro-icon.svg'
import codexIconDark from '../assets/codex-icon-dark.svg'
import codexIconLight from '../assets/codex-icon-light.svg'

type ProviderStatus = {
  name: string
  providerType: string
  displayName?: string
  enabled: boolean
  configured: boolean
  status: string
  message?: string
  models: string[]
}

type ServerInfo = {
  running: boolean
}

const GATEWAY_LOGOS: Record<string, { light: string; dark: string }> = {
  kiro: { light: kiroIcon, dark: kiroIcon },
  codex: { light: codexIconLight, dark: codexIconDark }
}

export default function Sidebar(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { theme, toggle } = useTheme()
  const { toast } = useToast()
  const [gateways, setGateways] = useState<ProviderStatus[]>([])
  const [server, setServer] = useState<ServerInfo>({ running: false })
  const [updateInfo, setUpdateInfo] = useState<{
    version: string
    releaseNotes: string | null
    releaseDate: string
    installMethod?: 'brew' | 'manual'
  } | null>(null)
  const [updateModalOpen, setUpdateModalOpen] = useState(false)

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

  useEffect(() => {
    const unsubs = [
      window.api.updater.onUpdateAvailable((data) => setUpdateInfo(data)),
      window.api.updater.onError((msg) => console.error('[updater]', msg))
    ]
    return () => unsubs.forEach((fn) => fn())
  }, [])

  const configuredGateways = gateways.filter((p) => p.enabled)

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
            displayName={gw.displayName}
            providerType={gw.providerType}
            status={gw.status}
            theme={theme}
          />
        ))}

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
          to="/api-keys"
          className={({ isActive }) => (isActive ? 'sidebar-item-active' : 'sidebar-item')}
        >
          <span className="i-ph-key text-[16px]" />
          <span>{t('sidebar.apiKeys')}</span>
        </NavLink>

        <NavLink
          to="/model-mappings"
          className={({ isActive }) => (isActive ? 'sidebar-item-active' : 'sidebar-item')}
        >
          <span className="i-ph-arrows-left-right text-[16px]" />
          <span>{t('sidebar.modelMappings')}</span>
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
        <button
          type="button"
          role="switch"
          aria-checked={server.running}
          aria-label={server.running ? t('sidebar.running') : t('sidebar.stopped')}
          className="flex items-center gap-2 px-2 py-0.5 outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          onClick={() => {
            const action = server.running ? window.api.gateway.stop() : window.api.gateway.start()
            action.then(refresh).catch((err) => {
              refresh()
              const raw = err?.message ?? String(err)
              const portMatch = raw.match(/(?:port|端口)\s*(\d+)/i)
              const port = portMatch?.[1]
              const code = /EADDRINUSE/.test(raw)
                ? 'EADDRINUSE'
                : /EACCES/.test(raw)
                  ? 'EACCES'
                  : /EADDRNOTAVAIL/.test(raw)
                    ? 'EADDRNOTAVAIL'
                    : null
              const localized = code
                ? t(`sidebar.serverError.${code}`, {
                    defaultValue: raw,
                    port: port ?? '?'
                  })
                : raw
              const prefix = server.running ? t('sidebar.stopFailed') : t('sidebar.startFailed')
              toast(`${prefix}: ${localized}`, 'error')
            })
          }}
        >
          <div
            className={`relative w-7 h-4 rounded-full transition-colors duration-200 ${server.running ? 'bg-emerald' : 'bg-charcoal border border-ash/60'}`}
          >
            <div
              className={`absolute top-0.5 w-3 h-3 rounded-full transition-[left,background-color] duration-200 shadow-sm t-icon-swap ${server.running ? 'left-3.5 bg-white' : 'left-0.5 bg-fog'}`}
            />
          </div>
          <span
            className={`text-[12px] font-medium ${server.running ? 'text-emerald' : 'text-fog'}`}
          >
            {server.running ? t('sidebar.running') : t('sidebar.stopped')}
          </span>
        </button>
        <div className="flex items-center gap-0.5">
          {updateInfo && (
            <TooltipWrapper content={t('updater.newVersion', { version: updateInfo.version })}>
              <Button
                variant="ghost"
                size="xs"
                iconOnly
                onClick={() => setUpdateModalOpen(true)}
                aria-label="Update available"
              >
                <span className="relative">
                  <span
                    className="i-ph-arrow-circle-up text-[14px] text-warning"
                    aria-hidden="true"
                  />
                  <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />
                </span>
              </Button>
            </TooltipWrapper>
          )}
          <TooltipWrapper content={t('sidebar.toggleLang')}>
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              onClick={toggleLang}
              aria-label="Toggle language"
            >
              <span
                className="i-ph-translate text-[14px] text-storm hover:text-porcelain"
                aria-hidden="true"
              />
            </Button>
          </TooltipWrapper>
          <TooltipWrapper content={t('sidebar.toggleTheme')}>
            <Button variant="ghost" size="xs" iconOnly onClick={toggle} aria-label="Toggle theme">
              {theme === 'dark' ? (
                <span
                  className="i-ph-sun-dim text-[14px] text-storm hover:text-porcelain"
                  aria-hidden="true"
                />
              ) : (
                <span
                  className="i-ph-moon-stars text-[14px] text-storm hover:text-porcelain"
                  aria-hidden="true"
                />
              )}
            </Button>
          </TooltipWrapper>
        </div>
      </div>
      <UpdateModal
        open={updateModalOpen}
        onOpenChange={setUpdateModalOpen}
        updateInfo={updateInfo}
        onInstall={() => {
          window.api.updater.install()
          setUpdateModalOpen(false)
        }}
      />
    </aside>
  )
}

function GatewayNavItem({
  name,
  displayName,
  providerType,
  status,
  theme
}: {
  name: string
  displayName?: string
  providerType: string
  status: string
  theme: 'light' | 'dark'
}): React.JSX.Element {
  const dotClass =
    status === 'ready' || status === 'running'
      ? 'pulse-dot-green'
      : status === 'error'
        ? 'pulse-dot-red'
        : 'pulse-dot-gray'
  const logoSet = GATEWAY_LOGOS[providerType]
  const logo = logoSet ? logoSet[theme] : undefined
  const label = displayName || providerType

  return (
    <NavLink
      to={`/gateway/${name}`}
      className={({ isActive }) => (isActive ? 'sidebar-item-active' : 'sidebar-item')}
    >
      <div className="w-4 h-4 flex items-center justify-center shrink-0">
        {logo ? (
          <img
            src={logo}
            alt={label}
            width="14"
            height="14"
            className="w-3.5 h-3.5 rounded-[2.5px] object-contain"
          />
        ) : (
          <span className={`${dotClass} !w-1.5 !h-1.5`} aria-hidden="true" />
        )}
      </div>
      <span className="capitalize ml-0.5">{label}</span>
      {logo && (
        <div className="ml-auto w-4 h-4 flex items-center justify-center shrink-0">
          <span className={`${dotClass} !w-1.5 !h-1.5`} aria-hidden="true" />
        </div>
      )}
    </NavLink>
  )
}
