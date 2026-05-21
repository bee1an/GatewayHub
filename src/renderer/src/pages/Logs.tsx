import { useState, useMemo, useRef, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
import { usePolling } from '../hooks/usePolling'
import { ToggleFilter } from '../components/ui/ToggleFilter'
import { Button } from '../components/ui/Button'
import { useToast } from '../components/ui/ToastContext'

type LogEntry = {
  ts: number
  level: string
  message: string
  provider?: string
  accountId?: string
  requestId?: string
  category?: string
  statusCode?: number
  duration?: number
  streaming?: boolean
  timeToFirstToken?: number
  chunkCount?: number
  error?: { stack?: string; upstreamBody?: string }
  extra?: Record<string, unknown>
}

type GatewayStatus = {
  server: { running: boolean }
  providers: Array<{
    name: string
    enabled: boolean
    configured: boolean
    status: string
    models: string[]
  }>
  logs: LogEntry[]
}

const LEVEL_BORDER_COLORS: Record<string, string> = {
  error: 'border-l-red',
  warn: 'border-l-warning',
  info: 'border-l-emerald',
  debug: 'border-l-fog'
}

const LEVEL_CHIP_COLORS: Record<string, string> = {
  error: 'text-red bg-[color-mix(in_srgb,var(--c-red)_12%,transparent)]',
  warn: 'text-warning bg-[color-mix(in_srgb,var(--c-warning)_12%,transparent)]',
  info: 'text-emerald bg-[color-mix(in_srgb,var(--c-emerald)_12%,transparent)]',
  debug: 'text-fog bg-[color-mix(in_srgb,var(--c-fog)_12%,transparent)]'
}

const CATEGORY_COLORS: Record<string, string> = {
  system: 'text-steel bg-[color-mix(in_srgb,var(--c-steel)_12%,transparent)]',
  auth: 'text-warning bg-[color-mix(in_srgb,var(--c-warning)_12%,transparent)]',
  request: 'text-emerald bg-[color-mix(in_srgb,var(--c-emerald)_12%,transparent)]',
  upstream: 'text-sky bg-[color-mix(in_srgb,var(--c-sky,#38bdf8)_12%,transparent)]',
  account: 'text-violet bg-[color-mix(in_srgb,var(--c-violet)_12%,transparent)]'
}

const TIME_RANGES = [
  { value: 'all', label: 'All' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '1h', label: '1h' }
]

function getTimeThreshold(range: string): number {
  if (range === 'all') return 0
  const now = Date.now()
  if (range === '5m') return now - 5 * 60_000
  if (range === '15m') return now - 15 * 60_000
  if (range === '1h') return now - 60 * 60_000
  return 0
}

function statusCodeColor(code?: number): string {
  if (!code) return 'text-fog'
  if (code >= 200 && code < 300) return 'text-emerald'
  if (code >= 400 && code < 500) return 'text-warning'
  return 'text-red'
}

const MAX_LOG_ENTRIES = 1000

export default function Logs(): React.JSX.Element {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [filter, setFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [timeRange, setTimeRange] = useState('all')
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)
  const [live, setLive] = useState(true)
  const [requestIdFilter, setRequestIdFilter] = useState<string | null>(null)

  const { data: status, refresh } = usePolling<GatewayStatus>(
    () => window.api.gateway.status(),
    live ? 2000 : 0
  )
  const parentRef = useRef<HTMLDivElement>(null)

  const logs = useMemo(() => {
    const raw = status?.logs ?? []
    const threshold = getTimeThreshold(timeRange)
    const searchLower = search.toLowerCase()

    return [...raw].reverse().filter((l) => {
      if (filter !== 'all' && l.level !== filter) return false
      if (categoryFilter !== 'all' && l.category !== categoryFilter) return false
      if (requestIdFilter && l.requestId !== requestIdFilter) return false
      if (threshold > 0 && l.ts < threshold) return false
      if (
        searchLower &&
        !l.message.toLowerCase().includes(searchLower) &&
        !(l.provider ?? '').toLowerCase().includes(searchLower) &&
        !(l.accountId ?? '').toLowerCase().includes(searchLower) &&
        !(l.requestId ?? '').toLowerCase().includes(searchLower) &&
        !(l.category ?? '').toLowerCase().includes(searchLower)
      )
        return false
      return true
    })
  }, [status?.logs, filter, categoryFilter, search, timeRange, requestIdFilter])

  const atMax = (status?.logs?.length ?? 0) >= MAX_LOG_ENTRIES

  useEffect(() => {
    if (live && parentRef.current && parentRef.current.scrollTop < 10) {
      parentRef.current.scrollTop = 0
    }
  }, [logs.length, live])

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: logs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: useCallback(
      (index: number) => (index === expandedIndex ? 180 : 32),
      [expandedIndex]
    ),
    overscan: 20
  })

  async function handleClear(): Promise<void> {
    await window.api.gateway.clearLogs()
    await refresh()
    toast(t('logs.cleared'), 'success')
  }

  async function handleExport(): Promise<void> {
    try {
      const path = await window.api.gateway.exportLogs('ndjson')
      toast(t('logs.exported', { path }), 'success')
    } catch (err: any) {
      toast(err.message || 'Export failed', 'error')
    }
  }

  function handleRequestIdClick(rid: string): void {
    setRequestIdFilter(requestIdFilter === rid ? null : rid)
  }

  return (
    <div className="flex flex-col gap-3 h-[calc(100vh-80px)]">
      <div className="flex items-center justify-between shrink-0">
        <h1 className="section-title">{t('logs.title')}</h1>
        <div className="flex items-center gap-2">
          <Button onClick={handleExport} variant="ghost" size="sm">
            <span className="i-ph-export text-[13px]" aria-hidden="true" />
            {t('logs.export')}
          </Button>
          <Button onClick={handleClear} variant="ghost" size="sm">
            <span className="i-ph-trash text-[13px]" aria-hidden="true" />
            {t('logs.clear')}
          </Button>
          <Button onClick={() => setLive(!live)} variant={live ? 'ghost' : 'default'} size="sm">
            <span
              className={`w-1.5 h-1.5 rounded-full ${live ? 'bg-emerald animate-pulse-green' : 'bg-fog'}`}
            />
            {live ? t('logs.live') : t('logs.paused')}
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0 flex-wrap">
        <input
          type="text"
          placeholder={t('logs.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoComplete="off"
          aria-label={t('logs.search')}
          className="input-base !w-[180px] !py-1.5 !text-[12px]"
        />
        <ToggleFilter
          value={filter}
          onValueChange={setFilter}
          items={[
            { value: 'all', label: t('logs.all') },
            { value: 'info', label: t('logs.info') },
            { value: 'warn', label: t('logs.warn') },
            { value: 'error', label: t('logs.error') }
          ]}
        />
        <ToggleFilter
          value={categoryFilter}
          onValueChange={setCategoryFilter}
          items={[
            { value: 'all', label: t('logs.all') },
            { value: 'system', label: t('logs.categorySystem') },
            { value: 'auth', label: t('logs.categoryAuth') },
            { value: 'request', label: t('logs.categoryRequest') },
            { value: 'upstream', label: t('logs.categoryUpstream') },
            { value: 'account', label: t('logs.categoryAccount') }
          ]}
        />
        <ToggleFilter value={timeRange} onValueChange={setTimeRange} items={TIME_RANGES} />
        {requestIdFilter && (
          <button
            onClick={() => setRequestIdFilter(null)}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-sky/10 text-sky text-[11px] font-mono"
          >
            rid:{requestIdFilter.slice(0, 8)}
            <span className="i-ph-x text-[10px]" />
          </button>
        )}
        <span className="ml-auto text-[12px] text-fog tabular-nums">
          {t('logs.entries', { count: logs.length })}
        </span>
      </div>

      <div ref={parentRef} className="card flex-1 overflow-y-auto min-h-0">
        {logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-fog text-[13px] gap-2">
            <span
              className="i-ph-list-magnifying-glass text-[24px] text-charcoal"
              aria-hidden="true"
            />
            {t('logs.noMatch')}
          </div>
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              position: 'relative',
              width: '100%'
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const log = logs[virtualRow.index]
              const isExpanded = expandedIndex === virtualRow.index
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`
                  }}
                >
                  <LogRow
                    log={log}
                    expanded={isExpanded}
                    onClick={() => setExpandedIndex(isExpanded ? null : virtualRow.index)}
                    onRequestIdClick={handleRequestIdClick}
                  />
                </div>
              )
            })}
          </div>
        )}
        {atMax && logs.length > 0 && (
          <div className="text-center text-[11px] text-fog py-2 border-t border-charcoal/30">
            {t('logs.maxReached')}
          </div>
        )}
      </div>
    </div>
  )
}

function LogRow({
  log,
  expanded,
  onClick,
  onRequestIdClick
}: {
  log: LogEntry
  expanded: boolean
  onClick: () => void
  onRequestIdClick: (rid: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const levelBorder = LEVEL_BORDER_COLORS[log.level] ?? 'border-l-fog'
  const levelChip =
    LEVEL_CHIP_COLORS[log.level] ?? 'text-fog bg-[color-mix(in_srgb,var(--c-fog)_12%,transparent)]'
  const time = new Date(log.ts).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })

  return (
    <div
      className={`border-l-[3px] ${levelBorder} transition-colors duration-75 ${expanded ? 'bg-[color-mix(in_srgb,var(--c-slate)_60%,transparent)]' : ''}`}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onClick()
          }
        }}
        className={`flex items-center gap-2 px-3 py-1.5 border-b border-charcoal/30 cursor-pointer ${expanded ? '' : 'hover:bg-[color-mix(in_srgb,var(--c-slate)_30%,transparent)]'}`}
      >
        <time className="shrink-0 text-[12px] font-mono text-storm w-[60px] tabular-nums">
          {time}
        </time>
        <span
          className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide ${levelChip}`}
        >
          {log.level}
        </span>
        {log.category && (
          <span
            className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${CATEGORY_COLORS[log.category] ?? 'text-fog bg-[color-mix(in_srgb,var(--c-fog)_12%,transparent)]'}`}
          >
            {log.category}
          </span>
        )}
        <p className="text-[12px] text-porcelain/85 truncate flex-1 min-w-0">{log.message}</p>
        {log.duration !== undefined && (
          <span className="shrink-0 text-[11px] font-mono text-storm tabular-nums">
            {log.duration}ms
          </span>
        )}
        {log.statusCode !== undefined && (
          <span
            className={`shrink-0 text-[11px] font-mono tabular-nums ${statusCodeColor(log.statusCode)}`}
          >
            {log.statusCode}
          </span>
        )}
        {log.accountId && (
          <span
            className="shrink-0 max-w-[160px] truncate text-[11px] font-mono text-fog tabular-nums"
            title={log.accountId}
          >
            {log.accountId}
          </span>
        )}
        {log.provider && <span className="shrink-0 tag text-[11px]">{log.provider}</span>}
      </div>

      {expanded && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="px-4 py-2.5 border-b border-charcoal/30 bg-pitch/30 shadow-[inset_0_1px_3px_rgba(0,0,0,0.15)] animate-slide-down"
        >
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12px]">
            <span className="text-fog">{t('logs.time')}</span>
            <span className="font-mono tabular-nums text-steel">
              {new Date(log.ts).toLocaleString()}.{String(log.ts % 1000).padStart(3, '0')}
            </span>
            <span className="text-fog">{t('logs.level')}</span>
            <span className="text-steel">{log.level}</span>
            {log.category && (
              <>
                <span className="text-fog">{t('logs.category')}</span>
                <span
                  className={`inline-block px-1.5 py-0.5 rounded text-[11px] w-fit ${CATEGORY_COLORS[log.category] ?? 'text-fog bg-[color-mix(in_srgb,var(--c-fog)_12%,transparent)]'}`}
                >
                  {log.category}
                </span>
              </>
            )}
            <span className="text-fog">{t('logs.message')}</span>
            <span className="text-steel break-all">{log.message}</span>
            {log.requestId && (
              <>
                <span className="text-fog">{t('logs.requestId')}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onRequestIdClick(log.requestId!)
                  }}
                  className="font-mono text-sky hover:underline text-left w-fit"
                >
                  {log.requestId}
                </button>
              </>
            )}
            {log.statusCode !== undefined && (
              <>
                <span className="text-fog">{t('logs.statusCode')}</span>
                <span className={`font-mono ${statusCodeColor(log.statusCode)}`}>
                  {log.statusCode}
                </span>
              </>
            )}
            {log.duration !== undefined && (
              <>
                <span className="text-fog">{t('logs.duration')}</span>
                <span className="font-mono text-steel tabular-nums">{log.duration}ms</span>
              </>
            )}
            {log.streaming && (
              <>
                <span className="text-fog">{t('logs.streaming')}</span>
                <span className="text-steel">
                  TTFT: {log.timeToFirstToken ?? '-'}ms | Chunks: {log.chunkCount ?? '-'}
                </span>
              </>
            )}
            {log.provider && (
              <>
                <span className="text-fog">{t('logs.provider')}</span>
                <span className="text-steel">{log.provider}</span>
              </>
            )}
            {log.accountId && (
              <>
                <span className="text-fog">{t('logs.account')}</span>
                <span className="font-mono text-steel break-all">{log.accountId}</span>
              </>
            )}
            {log.error?.stack && (
              <>
                <span className="text-fog">Stack</span>
                <pre className="text-[11px] text-red/80 whitespace-pre-wrap break-all max-h-[120px] overflow-y-auto">
                  {log.error.stack}
                </pre>
              </>
            )}
            {log.error?.upstreamBody && (
              <>
                <span className="text-fog">Upstream</span>
                <pre className="text-[11px] text-warning/80 whitespace-pre-wrap break-all max-h-[80px] overflow-y-auto">
                  {log.error.upstreamBody}
                </pre>
              </>
            )}
            {log.extra && Object.keys(log.extra).length > 0 && (
              <>
                <span className="text-fog">Extra</span>
                <span className="font-mono text-steel text-[11px]">
                  {JSON.stringify(log.extra)}
                </span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
