import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../components/ui/Button'
import { TooltipWrapper } from '../components/ui/Tooltip'
import { normalizeAccountModels } from './accountModelUtils'
import type { Account, AccountInfo, AccountStatus } from './gatewayDetailTypes'

function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])

  return now
}

export function AccountRow({
  account: acc,
  info,
  busy,
  expanded,
  onToggleExpand,
  last,
  onToggle,
  onRemove,
  onReset,
  onPauseToggle,
  onRefreshInfo,
  onRefreshModels,
  modelsRefreshing = false
}: {
  account: Account
  info?: { data?: AccountInfo; loading: boolean; error?: string }
  busy: boolean
  expanded: boolean
  onToggleExpand: () => void
  last: boolean
  onToggle: () => void
  onRemove: () => void
  onReset: () => void
  onPauseToggle: () => void
  onRefreshInfo: () => void
  onRefreshModels?: () => void
  modelsRefreshing?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const [modelsExpanded, setModelsExpanded] = useState(false)
  const status: AccountStatus = acc.status ?? 'available'
  const isPaused = status === 'manual_disabled'
  const statusVisual = getStatusVisual(status)
  const now = useNow()
  const dotClass = !acc.enabled ? 'pulse-dot-gray' : statusVisual.dotClass
  const total = acc.stats?.totalRequests ?? 0
  const success = acc.stats?.successfulRequests ?? 0
  const rate = total > 0 ? Math.round((success / total) * 100) : null
  const accountInfo = info?.data
  const models = normalizeAccountModels(accountInfo?.models)

  const expiresAt = acc.expiresAt ? new Date(acc.expiresAt) : null
  const expiresIn = expiresAt ? expiresAt.getTime() - now : null
  const expiryUrgent = expiresIn !== null && expiresIn < 24 * 3600_000

  const usagePercent = accountInfo?.usage
    ? Math.round((accountInfo.usage.used / Math.max(1, accountInfo.usage.limit)) * 100)
    : null
  const hasOverage = (accountInfo?.usage?.overages ?? 0) > 0

  const rateLimits = accountInfo?.rateLimits
  const rateLimitPeakPercent = rateLimits
    ? Math.max(rateLimits.primary?.usedPercent ?? 0, rateLimits.secondary?.usedPercent ?? 0)
    : null
  const peakPercent = (() => {
    const candidates = [usagePercent, rateLimitPeakPercent].filter(
      (v): v is number => typeof v === 'number'
    )
    if (!candidates.length) return null
    return Math.round(Math.max(...candidates))
  })()

  const cooldownRemaining =
    acc.cooldownUntil && acc.cooldownUntil > now ? acc.cooldownUntil - now : null

  const borderColor = (() => {
    if (!acc.enabled) return 'border-l-fog/40'
    switch (status) {
      case 'available':
        return 'border-l-emerald'
      case 'cooling':
      case 'rate_limited':
        return 'border-l-warning'
      case 'quota_exceeded':
      case 'auth_failed':
        return 'border-l-red'
      case 'manual_disabled':
      default:
        return 'border-l-fog/30'
    }
  })()

  return (
    <div
      className={`border-l-[2.5px] ${borderColor} ${!last ? 'border-b border-b-charcoal/30' : ''} ${!acc.enabled ? 'opacity-50' : ''} transition-colors duration-75 ${expanded ? 'bg-[color-mix(in_srgb,var(--c-slate)_50%,transparent)]' : ''}`}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onToggleExpand}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggleExpand()
          }
        }}
        className={`flex items-center gap-2 px-3 py-2 cursor-pointer select-none ${expanded ? '' : 'hover:bg-[color-mix(in_srgb,var(--c-slate)_30%,transparent)]'}`}
      >
        <span className={dotClass} />
        <span className="text-[13px] font-medium text-porcelain truncate min-w-0 flex-1">
          {accountInfo?.email || acc.label || acc.id}
        </span>
        {accountInfo?.subscription &&
          accountInfo.subscription.type !== 'unknown' &&
          accountInfo.subscription.title &&
          !/^[\s—–-]+$/.test(accountInfo.subscription.title) && (
            <span className="tag text-[10px] !px-1.5 !py-0 text-porcelain bg-charcoal border border-ash/20 shrink-0">
              {accountInfo.subscription.title}
            </span>
          )}
        <span className={`${statusVisual.badgeClass} !px-1.5 !py-0 shrink-0 text-[10px]`}>
          {t(`gateway.${statusVisual.i18nKey}`)}
          {cooldownRemaining && (
            <span className="ml-0.5 font-mono tabular-nums opacity-90">
              ({formatDuration(cooldownRemaining)})
            </span>
          )}
        </span>
        {peakPercent !== null && peakPercent > 80 && (
          <TooltipWrapper
            content={
              accountInfo?.usage
                ? `${t('gateway.usage')}: ${accountInfo.usage.used}/${accountInfo.usage.limit}`
                : `${t('gateway.usage')}: ${peakPercent}%`
            }
          >
            <span
              className={`text-[10px] font-mono tabular-nums shrink-0 ${hasOverage ? 'text-red' : 'text-warning'}`}
            >
              {peakPercent}%
            </span>
          </TooltipWrapper>
        )}
        {total > 0 && (
          <TooltipWrapper
            content={`${t('gateway.requests')}: ${total} (${t('gateway.success')}: ${success})`}
          >
            <span className="text-[11px] text-fog font-mono tabular-nums shrink-0 flex items-center gap-0.5">
              <span className="i-ph-arrow-up-right text-[10px]" aria-hidden="true" />
              {total}
            </span>
          </TooltipWrapper>
        )}
        {(() => {
          const errMsg = info?.error || accountInfo?.error || acc.lastError
          if (!errMsg) return null
          return (
            <TooltipWrapper content={errMsg}>
              <span
                className="i-ph-warning-circle-fill text-red text-[13px] shrink-0 cursor-help"
                aria-hidden="true"
              />
            </TooltipWrapper>
          )
        })()}
        <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
          <TooltipWrapper content={t('gateway.refresh')}>
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              onClick={onRefreshInfo}
              disabled={info?.loading}
              aria-label={t('gateway.refresh')}
              className="!h-6 !w-6"
            >
              <span
                aria-hidden="true"
                className={`text-[12px] text-storm ${info?.loading ? 'i-svg-spinners:ring-resize' : 'i-ph-arrows-clockwise'}`}
              />
            </Button>
          </TooltipWrapper>
          {acc.failures > 0 && (
            <TooltipWrapper content={t('gateway.reset')}>
              <Button
                variant="ghost"
                size="xs"
                iconOnly
                disabled={busy}
                onClick={onReset}
                aria-label={t('gateway.reset')}
                className="!h-6 !w-6"
              >
                <span
                  aria-hidden="true"
                  className="i-ph-arrow-counter-clockwise text-[12px] text-storm"
                />
              </Button>
            </TooltipWrapper>
          )}
          {acc.enabled && (
            <TooltipWrapper content={isPaused ? t('gateway.resume') : t('gateway.pause')}>
              <Button
                variant="ghost"
                size="xs"
                iconOnly
                disabled={busy}
                onClick={onPauseToggle}
                aria-label={isPaused ? t('gateway.resume') : t('gateway.pause')}
                className="!h-6 !w-6"
              >
                <span
                  aria-hidden="true"
                  className={`text-[12px] text-storm ${isPaused ? 'i-ph-play' : 'i-ph-pause'}`}
                />
              </Button>
            </TooltipWrapper>
          )}
          <TooltipWrapper content={acc.enabled ? t('gateway.disable') : t('gateway.enable')}>
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              disabled={busy}
              onClick={onToggle}
              aria-label={acc.enabled ? t('gateway.disable') : t('gateway.enable')}
              className="!h-6 !w-6"
            >
              <span
                aria-hidden="true"
                className={`text-[12px] text-storm ${acc.enabled ? 'i-ph-power' : 'i-ph-power text-emerald'}`}
              />
            </Button>
          </TooltipWrapper>
          <TooltipWrapper content={t('gateway.remove')}>
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              disabled={busy}
              onClick={onRemove}
              aria-label={t('gateway.remove')}
              className="!h-6 !w-6"
            >
              <span
                aria-hidden="true"
                className="i-ph-trash text-[12px] text-storm hover:text-red"
              />
            </Button>
          </TooltipWrapper>
        </div>
        <span
          className={`i-ph-caret-down text-[11px] text-fog shrink-0 transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-1 animate-slide-down space-y-3">
          {(rateLimits?.primary || rateLimits?.secondary) && (
            <div className="space-y-1.5">
              {rateLimits.primary && (
                <RateLimitBar
                  label={t('gateway.rateLimitPrimary')}
                  window={rateLimits.primary}
                  now={now}
                  resetsInLabel={t('gateway.resetsIn')}
                />
              )}
              {rateLimits.secondary && (
                <RateLimitBar
                  label={t('gateway.rateLimitSecondary')}
                  window={rateLimits.secondary}
                  now={now}
                  resetsInLabel={t('gateway.resetsIn')}
                />
              )}
            </div>
          )}

          {accountInfo?.usage && (
            <div className="flex items-center gap-2 text-[11px]">
              <div
                role="progressbar"
                aria-valuenow={accountInfo.usage.used}
                aria-valuemin={0}
                aria-valuemax={accountInfo.usage.limit}
                aria-label={t('gateway.usage')}
                className="flex-1 h-1.5 rounded-full bg-charcoal/50 overflow-hidden"
              >
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    hasOverage ? 'bg-red' : usagePercent! > 80 ? 'bg-warning' : 'bg-emerald'
                  }`}
                  style={{ width: `${Math.min(usagePercent!, 100)}%` }}
                />
              </div>
              <span
                className={`font-mono tabular-nums font-medium shrink-0 ${hasOverage ? 'text-red' : 'text-storm'}`}
              >
                {accountInfo.usage.used}/{accountInfo.usage.limit}
              </span>
            </div>
          )}

          <div className="text-[11px] flex flex-wrap gap-x-5 gap-y-1">
            {rate !== null && (
              <div className="flex items-center gap-1.5">
                <span className="text-fog">{t('gateway.successRate')}</span>
                <span
                  className={`font-mono tabular-nums font-medium ${statusVisual.rateColorClass}`}
                >
                  {rate}%
                </span>
              </div>
            )}
            {accountInfo?.usage?.resetDate && (
              <div className="flex items-center gap-1.5">
                <span className="text-fog">{t('gateway.resetDate')}</span>
                <span className="font-mono tabular-nums text-storm">
                  {formatResetDate(accountInfo.usage.resetDate)}
                </span>
              </div>
            )}
            {expiresAt && (
              <div className="flex items-center gap-1.5">
                <span className="text-fog">{t('gateway.expires')}</span>
                <span
                  className={`font-mono tabular-nums ${expiryUrgent ? 'text-red' : 'text-storm'}`}
                >
                  {formatDuration(expiresIn!)}
                </span>
              </div>
            )}
            {hasOverage && accountInfo?.usage && (
              <div className="flex items-center gap-1.5">
                <span className="text-fog">{t('gateway.overages')}</span>
                <span className="font-mono tabular-nums text-red">
                  +{accountInfo.usage.overages} (${accountInfo.usage.overageCharges.toFixed(2)})
                </span>
              </div>
            )}
          </div>

          {accountInfo && (models.length > 0 || onRefreshModels) && (
            <div>
              <div className="flex items-center gap-1.5">
                <button
                  className="text-[11px] text-fog hover:text-storm inline-flex items-center gap-1 font-medium transition-colors"
                  onClick={(e) => {
                    e.stopPropagation()
                    setModelsExpanded(!modelsExpanded)
                  }}
                >
                  <span className="text-[9px]" aria-hidden="true">
                    {modelsExpanded ? '▼' : '▶'}
                  </span>
                  {t('gateway.models')} ({models.length})
                </button>
                {onRefreshModels && (
                  <TooltipWrapper content={t('gateway.refreshModels')}>
                    <Button
                      variant="ghost"
                      size="xs"
                      iconOnly
                      loading={modelsRefreshing}
                      onClick={(e) => {
                        e.stopPropagation()
                        onRefreshModels()
                      }}
                      aria-label={t('gateway.refreshModels')}
                      className="!h-5 !w-5 text-fog hover:text-storm"
                    >
                      <span className="i-ph-arrows-clockwise text-[11px]" aria-hidden="true" />
                    </Button>
                  </TooltipWrapper>
                )}
              </div>
              {modelsExpanded && (
                <>
                  {models.length > 0 ? (
                    <div className="flex flex-wrap gap-1 mt-1.5 animate-slide-down">
                      {models.map((m) => (
                        <span
                          key={m.modelId}
                          className="tag text-[10px] font-mono !px-1.5 !py-0 bg-charcoal/40 text-storm"
                        >
                          {m.modelName || m.modelId}
                          {m.rateMultiplier > 1 && (
                            <span className="ml-0.5 text-warning font-semibold">
                              {m.rateMultiplier}x
                            </span>
                          )}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-1.5 text-[11px] text-fog animate-slide-down">
                      {t('gateway.noModels')}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {info?.loading && !accountInfo && (
            <span className="text-[11px] text-fog">{t('gateway.loadingInfo')}…</span>
          )}
        </div>
      )}
    </div>
  )
}

function RateLimitBar({
  label,
  window: w,
  now,
  resetsInLabel
}: {
  label: string
  window: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }
  now: number
  resetsInLabel: string
}): React.JSX.Element {
  const percent = Math.max(0, Math.min(100, Math.round(w.usedPercent)))
  const barColor = percent > 95 ? 'bg-red' : percent > 80 ? 'bg-warning' : 'bg-emerald'
  const valueColor = percent > 95 ? 'text-red' : percent > 80 ? 'text-warning' : 'text-storm'
  const remainsMs = w.resetsAt && w.resetsAt > now ? w.resetsAt - now : null
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="text-fog font-medium shrink-0 w-12">{label}</span>
      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        className="flex-1 h-1.5 rounded-full bg-charcoal/50 overflow-hidden"
      >
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className={`font-mono tabular-nums font-medium shrink-0 ${valueColor}`}>
        {percent}%
      </span>
      {remainsMs !== null && (
        <span className="text-fog tabular-nums shrink-0">
          {resetsInLabel} {formatDuration(remainsMs)}
        </span>
      )}
    </div>
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
