import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink, useMatch, useResolvedPath } from 'react-router-dom'
import { ProviderLogo } from './ProviderLogo'
import { getProviderLogoLabel } from './providerLogoData'
import { TooltipWrapper } from './ui/Tooltip'
import { useSidebarVisibility } from './useSidebarVisibility'
import { useTheme } from './useTheme'
import { changeLanguage } from '../i18n'
import gatewayHubMark from '../assets/gatewayhub-mark.png'

type ProviderStatus = {
  name: string
  providerType: string
  displayName?: string
  enabled: boolean
  configured: boolean
  status: string
}

const COLLAPSED_KEY = 'gatewayhub-sidebar-collapsed'

function navItemClass(active: boolean, collapsed: boolean): string {
  const base = collapsed
    ? 'flex items-center justify-center w-10 h-8 rounded-[var(--radius-sm)]'
    : 'flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-sm)]'
  const state = active
    ? 'text-porcelain bg-charcoal/60'
    : 'text-storm hover:text-porcelain hover:bg-charcoal/40'
  return `${base} text-[12px] transition-colors duration-100 ${state}`
}

// Radix Tooltip.Trigger asChild merges props via Slot, which stringifies a
// function className — so active state must be resolved here into a string.
function useNavActive(to: string, end?: boolean): boolean {
  const resolved = useResolvedPath(to)
  return Boolean(useMatch({ path: resolved.pathname, end: !!end }))
}

function SideNavLink({
  to,
  end,
  icon,
  title,
  collapsed,
  children
}: {
  to: string
  end?: boolean
  icon: string
  title: string
  collapsed: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const active = useNavActive(to, end)
  const link = (
    <NavLink
      to={to}
      end={end}
      title={title}
      aria-label={title}
      className={navItemClass(active, collapsed)}
    >
      {collapsed ? (
        <span className={`${icon} text-[15px] shrink-0`} aria-hidden="true" />
      ) : (
        <>
          <span className="flex w-[40px] shrink-0 justify-center">
            <span className={`${icon} text-[15px]`} aria-hidden="true" />
          </span>
          <span className="truncate">{children}</span>
        </>
      )}
    </NavLink>
  )
  return collapsed ? (
    <TooltipWrapper content={title} side="right">
      {link}
    </TooltipWrapper>
  ) : (
    link
  )
}

function ProviderNavLink({
  name,
  label,
  collapsed,
  children
}: {
  name: string
  label: string
  collapsed: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const active = useNavActive(`/gateway/${name}`)
  return (
    <NavLink
      to={`/gateway/${name}`}
      title={label}
      aria-label={label}
      className={navItemClass(active, collapsed)}
    >
      {children}
    </NavLink>
  )
}

export default function Sidebar(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { theme, toggle: toggleTheme } = useTheme()
  const { isVisible } = useSidebarVisibility()
  const [gateways, setGateways] = useState<ProviderStatus[]>([])
  const [running, setRunning] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<any>(null)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === '1')

  // The splash overlay is removed once the first gateway status lands; the
  // cross-fade marks `data-splash-dismissing` so the safety net in main.tsx
  // never races the transition.
  const dismissSplash = useCallback((): void => {
    const el = document.getElementById('splash')
    if (!el || el.dataset.splashDismissing === '1') return
    el.dataset.splashDismissing = '1'
    el.classList.add('is-done')
    setTimeout(() => el.remove(), 400)
  }, [])

  useEffect(() => {
    let mounted = true
    const refresh = (): void => {
      window.api.gateway
        .status()
        .then((s: any) => {
          if (!mounted) return
          setGateways(s.providers ?? [])
          setRunning(s.server?.running ?? false)
          dismissSplash()
        })
        .catch(() => {})
    }
    refresh()
    const interval = setInterval(refresh, 5000)
    return () => {
      mounted = false
      clearInterval(interval)
    }
  }, [dismissSplash])

  useEffect(() => {
    const unsubs = [
      window.api.updater.onUpdateAvailable((data) => setUpdateInfo(data)),
      window.api.updater.onError((msg) => console.error('[updater]', msg))
    ]
    return () => unsubs.forEach((fn) => fn())
  }, [])

  useEffect(() => {
    document.documentElement.style.setProperty('--gh-sb', collapsed ? '72px' : '148px')
  }, [collapsed])

  function toggleCollapsed(): void {
    setCollapsed((c) => {
      localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1')
      return !c
    })
  }

  const providers = gateways.filter((p) => p.enabled && isVisible(p.name))

  async function toggleServer(): Promise<void> {
    try {
      const result: any = running
        ? await window.api.gateway.stop()
        : await window.api.gateway.start()
      if (result?.ok === false) {
        console.error(result.error || t('sidebar.startFailed'))
      }
      const s: any = await window.api.gateway.status()
      setRunning(s.server?.running ?? false)
    } catch (e) {
      console.error('Failed to toggle server', e)
    }
  }

  const footerBtn =
    'flex items-center justify-center w-7 h-7 rounded-[var(--radius-sm)] text-storm transition-colors duration-100 hover:bg-charcoal/50 hover:text-porcelain outline-none focus-visible:ring-1 focus-visible:ring-accent/60'

  return (
    <aside
      className={`${collapsed ? 'w-[72px]' : 'w-[148px]'} shrink-0 flex flex-col border-r border-charcoal bg-graphite overflow-y-auto select-none transition-[width] duration-150`}
    >
      {/* macOS traffic lights sit at top-left ~70px; the 64px header keeps the
          mark below them, anchored to the same 72px rail center in both
          collapsed and expanded layouts so it doesn't shift on toggle. */}
      <div className="flex h-[64px] shrink-0 items-end pb-2 [-webkit-app-region:drag]">
        <div className="flex w-[72px] justify-center">
          <img
            src={gatewayHubMark}
            alt="GatewayHub"
            className="size-4.5 shrink-0 rounded-[3px]"
            draggable={false}
          />
        </div>
      </div>

      <nav
        className={`flex-1 flex flex-col py-1.5 gap-px ${collapsed ? 'items-center px-1.5' : 'px-2'}`}
      >
        <SideNavLink
          to="/dashboard"
          end
          icon="i-ph-gauge"
          title={t('sidebar.dashboard')}
          collapsed={collapsed}
        >
          {t('sidebar.dashboard')}
        </SideNavLink>
        <SideNavLink
          to="/logs"
          icon="i-ph-list-bullets"
          title={t('sidebar.logs')}
          collapsed={collapsed}
        >
          {t('sidebar.logs')}
        </SideNavLink>
        <SideNavLink
          to="/playground"
          icon="i-ph-chat-circle-dots"
          title={t('sidebar.playground')}
          collapsed={collapsed}
        >
          {t('sidebar.playground')}
        </SideNavLink>
        <SideNavLink
          to="/api-keys"
          icon="i-ph-key"
          title={t('sidebar.apiKeys')}
          collapsed={collapsed}
        >
          {t('sidebar.apiKeys')}
        </SideNavLink>
        <SideNavLink
          to="/model-mappings"
          icon="i-ph-arrows-left-right"
          title={t('sidebar.modelMappings')}
          collapsed={collapsed}
        >
          {t('sidebar.modelMappings')}
        </SideNavLink>

        {providers.length > 0 && (
          <div
            className={`${collapsed ? 'w-5' : 'mx-2'} my-2 border-t border-charcoal/60`}
            aria-hidden="true"
          />
        )}

        {providers.map((p) => {
          const label = getProviderLogoLabel(p.providerType, p.displayName)
          const link = (
            <ProviderNavLink key={p.name} name={p.name} label={label} collapsed={collapsed}>
              {collapsed ? (
                <ProviderLogo
                  providerType={p.providerType}
                  label={label}
                  theme={theme}
                  size="xs"
                  className={p.configured ? undefined : 'opacity-45 saturate-50'}
                />
              ) : (
                <>
                  <span className="flex w-[40px] shrink-0 justify-center">
                    <ProviderLogo
                      providerType={p.providerType}
                      label={label}
                      theme={theme}
                      size="xs"
                      className={p.configured ? undefined : 'opacity-45 saturate-50'}
                    />
                  </span>
                  <span className="truncate capitalize">{label}</span>
                </>
              )}
            </ProviderNavLink>
          )
          return collapsed ? (
            <TooltipWrapper key={p.name} content={label} side="right">
              {link}
            </TooltipWrapper>
          ) : (
            link
          )
        })}

        <div
          className={`${collapsed ? 'w-5' : 'mx-2'} my-2 border-t border-charcoal/60`}
          aria-hidden="true"
        />

        <SideNavLink
          to="/settings"
          icon="i-ph-gear"
          title={t('sidebar.settings')}
          collapsed={collapsed}
        >
          {t('sidebar.settings')}
        </SideNavLink>
      </nav>

      <div
        className={`shrink-0 border-t border-[color-mix(in_srgb,var(--c-charcoal)_60%,transparent)] ${
          collapsed
            ? 'flex flex-col items-center gap-0.5 px-1.5 py-2'
            : 'flex items-center px-2 py-1.5'
        }`}
      >
        <div
          className={collapsed ? 'flex flex-col items-center gap-0.5' : 'flex items-center gap-px'}
        >
          <button
            type="button"
            onClick={() => changeLanguage(i18n.language === 'zh' ? 'en' : 'zh')}
            className={footerBtn}
            title={t('sidebar.toggleLang')}
            aria-label={t('sidebar.toggleLang')}
          >
            <span className="i-ph-translate text-[14px]" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={(e) => toggleTheme({ x: e.clientX, y: e.clientY })}
            className={footerBtn}
            title={t('sidebar.toggleTheme')}
            aria-label={t('sidebar.toggleTheme')}
          >
            <span
              className={theme === 'dark' ? 'i-ph-sun text-[14px]' : 'i-ph-moon text-[14px]'}
              aria-hidden="true"
            />
          </button>
          {updateInfo && (
            <button
              type="button"
              onClick={() => window.api.updater.install()}
              className={`${footerBtn} text-accent`}
              title={t('updater.title')}
              aria-label={t('updater.title')}
            >
              <span className="i-ph-arrow-circle-up text-[14px]" aria-hidden="true" />
            </button>
          )}
        </div>
        {!collapsed && <span className="flex-1" />}
        <TooltipWrapper
          content={running ? t('dashboard.stop') : t('dashboard.start')}
          side={collapsed ? 'right' : 'top'}
        >
          <button
            type="button"
            role="switch"
            aria-checked={running}
            onClick={toggleServer}
            className={`${footerBtn} ${running ? 'text-accent' : ''}`}
            aria-label={running ? t('dashboard.stop') : t('dashboard.start')}
          >
            <span className="i-ph-power text-[14px]" aria-hidden="true" />
          </button>
        </TooltipWrapper>
        <TooltipWrapper
          content={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          side={collapsed ? 'right' : 'top'}
        >
          <button
            type="button"
            onClick={toggleCollapsed}
            className={footerBtn}
            aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          >
            <span
              className={
                collapsed
                  ? 'i-ph-caret-double-right text-[14px]'
                  : 'i-ph-caret-double-left text-[14px]'
              }
              aria-hidden="true"
            />
          </button>
        </TooltipWrapper>
      </div>
    </aside>
  )
}
