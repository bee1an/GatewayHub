import { NavLink } from 'react-router-dom'
import { useEffect, useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useTheme } from './useTheme'
import { useSidebarVisibility } from './useSidebarVisibility'
import { changeLanguage } from '../i18n'
import { Button } from './ui/Button'
import { TooltipWrapper } from './ui/Tooltip'
import { useToast } from './ui/ToastContext'
import { UpdateModal } from './UpdateModal'
import { ProviderLogo } from './ProviderLogo'
import { getProviderLogoLabel } from './providerLogoData'

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

export default function Sidebar(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { theme, toggle } = useTheme()
  const { isVisible } = useSidebarVisibility()
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
  const splashRemovedRef = useRef(false)

  const dismissSplashWhenReady = useCallback(() => {
    if (splashRemovedRef.current) return
    // The splash in index.html stays visible until the renderer is actually
    // styled. The IPC round-trip alone is not a reliable signal: in dev,
    // UnoCSS streams `virtual:uno.css` into the page asynchronously after the
    // module graph runs, so by the time `gateway.status()` resolves the atomic
    // classes (flex / bg-graphite / borders) may still be unstyled — that is
    // exactly the "few seconds of broken UI" we were seeing.
    //
    // The previous probe checked `--c-pitch`, but that variable lives in the
    // hand-written theme.css and is set before the IPC call ever fires, so it
    // gave a false-positive immediately. Instead we mount an off-screen probe
    // element that uses a UnoCSS atomic (`bg-graphite`) and wait for its
    // resolved background to become non-transparent — that only happens once
    // UnoCSS has injected its stylesheet.
    const probe = document.createElement('div')
    probe.className = 'bg-graphite'
    probe.style.cssText =
      'position:fixed;inset:auto;width:1px;height:1px;pointer-events:none;opacity:0;'
    document.body.appendChild(probe)
    const isStyleReady = (): boolean => {
      const bg = getComputedStyle(probe).backgroundColor
      // `bg-graphite` resolves to a non-transparent color once UnoCSS atomics
      // are live. Default `<div>` background is `rgba(0, 0, 0, 0)`.
      return !!bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent'
    }
    const dismiss = (): void => {
      if (splashRemovedRef.current) return
      splashRemovedRef.current = true
      probe.remove()
      const el = document.getElementById('splash')
      if (!el) return
      // Mark the splash as "dismiss in progress" so the main.tsx safety-net
      // timer doesn't yank it out from under the cross-fade if they happen to
      // race around the 8s mark.
      el.dataset.splashDismissing = '1'
      el.style.transition = 'opacity 200ms ease-out'
      el.style.opacity = '0'
      window.setTimeout(() => el.remove(), 220)
    }
    const fontsReady: Promise<unknown> =
      (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready ??
      Promise.resolve()
    const fontsWithTimeout = Promise.race([
      fontsReady,
      new Promise((resolve) => window.setTimeout(resolve, 1500))
    ])
    const finish = (): void => {
      // After UnoCSS + fonts are settled, wait two frames so the painter has a
      // chance to flush before we cross-fade the splash out.
      void fontsWithTimeout.then(() => {
        requestAnimationFrame(() => requestAnimationFrame(dismiss))
      })
    }
    const tick = (deadline: number): void => {
      if (isStyleReady() || Date.now() > deadline) {
        finish()
        return
      }
      window.setTimeout(() => tick(deadline), 32)
    }
    tick(Date.now() + 5000)
  }, [])

  const refresh = useCallback(() => {
    window.api.gateway
      .status()
      .then((s: any) => {
        setGateways(s.providers ?? [])
        setServer({ running: s.server?.running ?? false })
      })
      .finally(() => {
        dismissSplashWhenReady()
      })
  }, [dismissSplashWhenReady])

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

  const configuredGateways = gateways.filter((p) => p.enabled && isVisible(p.name))

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
            const wasRunning = server.running
            const action = wasRunning ? window.api.gateway.stop() : window.api.gateway.start()
            action
              .then((result: any) => {
                if (result?.ok === false) {
                  const error = new Error(
                    result.error ||
                      (wasRunning ? t('sidebar.stopFailed') : t('sidebar.startFailed'))
                  )
                  ;(error as any).code = result.code
                  throw error
                }
                refresh()
              })
              .catch((err) => {
                refresh()
                const raw = err?.message ?? String(err)
                const portMatch = raw.match(/(?:port|端口)\s*(\d+)/i)
                const port = portMatch?.[1]
                const code = err?.code
                  ? err.code
                  : /EADDRINUSE/.test(raw) || /already in use/i.test(raw)
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
                const prefix = wasRunning ? t('sidebar.stopFailed') : t('sidebar.startFailed')
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
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              onClick={(e) => toggle({ x: e.clientX, y: e.clientY })}
              aria-label="Toggle theme"
            >
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
  theme
}: {
  name: string
  displayName?: string
  providerType: string
  theme: 'light' | 'dark'
}): React.JSX.Element {
  const label = getProviderLogoLabel(providerType, displayName)

  return (
    <NavLink
      to={`/gateway/${name}`}
      className={({ isActive }) => (isActive ? 'sidebar-item-active' : 'sidebar-item')}
    >
      <ProviderLogo providerType={providerType} label={label} theme={theme} size="sm" />
      <span className="capitalize ml-0.5">{label}</span>
    </NavLink>
  )
}
