import { useState, useMemo, useRef, useCallback, useEffect, useDeferredValue } from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
import { usePolling } from '../hooks/usePolling'
import { ToggleFilter } from '../components/ui/ToggleFilter'
import { Button } from '../components/ui/Button'
import { useToast } from '../components/ui/ToastContext'
import { formatCostUsd, formatCredits, formatTokens } from '../utils/format'

type UsageStats = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWrite5mTokens?: number
  cacheWrite1hTokens?: number
  credits?: number
  estimated?: boolean
}

type CostStats = {
  inputUsd: number
  outputUsd: number
  cacheReadUsd: number
  cacheWriteUsd: number
  creditsUsd: number
  totalUsd: number
  currency: 'USD'
  basis: 'credit' | 'token' | 'none'
}

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
  model?: string
  apiFormat?: 'openai' | 'anthropic'
  usage?: UsageStats
  cost?: CostStats
  error?: { stack?: string; upstreamBody?: string }
  extra?: Record<string, unknown>
}

type GroupSummary = {
  startTime: number
  endTime: number
  duration: number
  statusCode?: number
  provider?: string
  accountId?: string
  model?: string
  usage?: UsageStats
  cost?: CostStats
  hasError: boolean
  count: number
  message: string
}

type GroupRow =
  | { type: 'group'; key: string; requestId: string; entries: LogEntry[]; summary: GroupSummary }
  | { type: 'single'; key: string; entry: LogEntry }

type GatewayStatus = {
  server: { running: boolean }
  providers: Array<{
    name: string
    enabled: boolean
    configured: boolean
    status: string
    models: string[]
    accounts?: Array<{ id: string; email?: string; label?: string }>
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

// Aggregate the entries of a single requestId into a group summary header.
// The completion/stream-end entry carries statusCode/duration/usage/cost/model;
// the request-start entry carries the message (path). account/provider may come
// from any entry in the group.
//
// Detection avoids relying on `!statusCode`: a stream-error log is also
// category='request' with no statusCode (its detail lives in error.stack), so
// that naive check would surface a stack trace as the group's message. Instead
// we key off sessionKey (always present on start logs) / usage / duration.
function buildGroupSummary(entries: LogEntry[]): GroupSummary {
  const sorted = [...entries].sort((a, b) => a.ts - b.ts)
  const startTime = sorted[0].ts
  const endTime = sorted[sorted.length - 1].ts
  const startEntry =
    sorted.find((e) => e.extra && typeof e.extra.sessionKey === 'string') ??
    sorted.find((e) => e.category === 'request' && /^(POST|GET|DELETE|PUT) /.test(e.message))
  const completionEntry =
    sorted.find((e) => e.usage) ?? sorted.find((e) => e.duration !== undefined)
  const hasError = sorted.some((e) => e.level === 'error')
  return {
    startTime,
    endTime,
    duration: endTime - startTime,
    statusCode: completionEntry?.statusCode,
    provider: sorted.find((e) => e.provider)?.provider,
    accountId: sorted.find((e) => e.accountId)?.accountId,
    model: completionEntry?.model ?? sorted.find((e) => e.model)?.model,
    usage: completionEntry?.usage,
    cost: completionEntry?.cost,
    hasError,
    count: sorted.length,
    message: startEntry?.message ?? sorted[0].message
  }
}

const MAX_LOG_ENTRIES = 1000

export default function Logs(): React.JSX.Element {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [filter, setFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [timeRange, setTimeRange] = useState('all')
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [live, setLive] = useState(true)
  const [requestIdFilter, setRequestIdFilter] = useState<string | null>(null)
  const [grouped, setGrouped] = useState(false)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  const { data: status, refresh } = usePolling<GatewayStatus>(
    () => window.api.gateway.status(),
    live ? 2000 : 0
  )
  const parentRef = useRef<HTMLDivElement>(null)

  const accountLabels = useMemo(() => {
    const map: Record<string, string> = {}
    for (const p of status?.providers ?? []) {
      for (const a of p.accounts ?? []) {
        const friendly = a.email || a.label
        if (friendly) map[a.id] = friendly
      }
    }
    return map
  }, [status?.providers])

  const reversed = useMemo(() => {
    const raw = status?.logs ?? []
    return [...raw].reverse()
  }, [status?.logs])

  const getLogKey = useCallback(
    (log: LogEntry): string =>
      `${log.ts}:${log.level}:${log.category ?? ''}:${log.message.slice(0, 32)}`,
    []
  )

  const logs = useMemo(() => {
    const threshold = getTimeThreshold(timeRange)
    const searchLower = deferredSearch.toLowerCase()

    return reversed.filter((l) => {
      if (filter !== 'all' && l.level !== filter) return false
      if (categoryFilter !== 'all' && l.category !== categoryFilter) return false
      if (requestIdFilter && l.requestId !== requestIdFilter) return false
      if (threshold > 0 && l.ts < threshold) return false
      if (
        searchLower &&
        !l.message.toLowerCase().includes(searchLower) &&
        !(l.provider ?? '').toLowerCase().includes(searchLower) &&
        !(l.accountId ?? '').toLowerCase().includes(searchLower) &&
        !(l.accountId ? (accountLabels[l.accountId] ?? '') : '')
          .toLowerCase()
          .includes(searchLower) &&
        !(l.requestId ?? '').toLowerCase().includes(searchLower) &&
        !(l.category ?? '').toLowerCase().includes(searchLower)
      )
        return false
      return true
    })
  }, [reversed, filter, categoryFilter, deferredSearch, timeRange, requestIdFilter, accountLabels])

  // When grouped mode is on, collapse same-requestId entries into group rows.
  // Entries without a requestId stay as standalone single rows. The mixed array
  // is sorted newest-first by each row's start time so the timeline reads top-down.
  const rows = useMemo<GroupRow[] | null>(() => {
    if (!grouped) return null
    const buckets = new Map<string, LogEntry[]>()
    const singles: { key: string; entry: LogEntry }[] = []
    for (const l of logs) {
      if (l.requestId) {
        const bucket = buckets.get(l.requestId)
        if (bucket) bucket.push(l)
        else buckets.set(l.requestId, [l])
      } else {
        singles.push({ key: getLogKey(l), entry: l })
      }
    }
    const mixed: GroupRow[] = []
    for (const [requestId, entries] of buckets) {
      const summary = buildGroupSummary(entries)
      mixed.push({ type: 'group', key: `g:${requestId}`, requestId, entries, summary })
    }
    for (const s of singles) {
      mixed.push({ type: 'single', key: s.key, entry: s.entry })
    }
    mixed.sort((a, b) => {
      const at = a.type === 'group' ? a.summary.startTime : a.entry.ts
      const bt = b.type === 'group' ? b.summary.startTime : b.entry.ts
      return bt - at
    })
    return mixed
  }, [logs, grouped, getLogKey])

  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const atMax = (status?.logs?.length ?? 0) >= MAX_LOG_ENTRIES

  useEffect(() => {
    if (live && parentRef.current && parentRef.current.scrollTop < 10) {
      parentRef.current.scrollTop = 0
    }
  }, [logs.length, live])

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: grouped ? (rows?.length ?? 0) : logs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: useCallback(
      (index: number) => {
        if (grouped && rows) {
          const row = rows[index]
          if (row.type === 'single') {
            return row.key === expandedKey ? 180 : 32
          }
          // group: header (32) + expanded children (each ~32, detail panel makes it taller)
          if (expandedGroups.has(row.key)) {
            return 32 + row.entries.length * 32
          }
          return 32
        }
        return getLogKey(logs[index]) === expandedKey ? 180 : 32
      },
      [grouped, rows, expandedGroups, expandedKey, logs, getLogKey]
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
            <span className={`w-1.5 h-1.5 rounded-full ${live ? 'bg-emerald' : 'bg-fog'}`} />
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
        <ToggleFilter
          value={grouped ? 'grouped' : 'flat'}
          onValueChange={(v) => setGrouped(v === 'grouped')}
          items={[
            { value: 'flat', label: t('logs.flat') },
            { value: 'grouped', label: t('logs.grouped') }
          ]}
        />
        {grouped && rows && (
          <>
            <Button
              onClick={() =>
                setExpandedGroups(
                  new Set(
                    rows
                      .filter((r): r is Extract<GroupRow, { type: 'group' }> => r.type === 'group')
                      .map((r) => r.key)
                  )
                )
              }
              variant="ghost"
              size="sm"
              title={t('logs.expandAll')}
            >
              <span className="i-ph-arrows-out-line-vertical text-[13px]" aria-hidden="true" />
              {t('logs.expandAll')}
            </Button>
            <Button
              onClick={() => setExpandedGroups(new Set())}
              variant="ghost"
              size="sm"
              title={t('logs.collapseAll')}
            >
              <span className="i-ph-arrows-in-line-vertical text-[13px]" aria-hidden="true" />
              {t('logs.collapseAll')}
            </Button>
          </>
        )}
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
        ) : grouped && rows ? (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              position: 'relative',
              width: '100%'
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index]
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
                  {row.type === 'single' ? (
                    <LogRow
                      log={row.entry}
                      expanded={expandedKey === row.key}
                      accountLabel={
                        row.entry.accountId ? accountLabels[row.entry.accountId] : undefined
                      }
                      onClick={() => setExpandedKey(expandedKey === row.key ? null : row.key)}
                      onRequestIdClick={handleRequestIdClick}
                    />
                  ) : (
                    <GroupBlock
                      row={row}
                      expanded={expandedGroups.has(row.key)}
                      expandedKey={expandedKey}
                      accountLabels={accountLabels}
                      getLogKey={getLogKey}
                      onToggle={() => toggleGroup(row.key)}
                      onRowClick={(key) => setExpandedKey(expandedKey === key ? null : key)}
                      onRequestIdClick={handleRequestIdClick}
                    />
                  )}
                </div>
              )
            })}
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
              const logKey = getLogKey(log)
              const isExpanded = expandedKey === logKey
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
                    accountLabel={log.accountId ? accountLabels[log.accountId] : undefined}
                    onClick={() => setExpandedKey(isExpanded ? null : logKey)}
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
  accountLabel,
  onClick,
  onRequestIdClick
}: {
  log: LogEntry
  expanded: boolean
  accountLabel?: string
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
        {log.usage &&
          (typeof log.usage.credits === 'number' && log.usage.credits > 0 ? (
            <span
              className="shrink-0 text-[11px] font-mono text-storm tabular-nums"
              title={`${log.usage.credits.toFixed(4)} credits${log.usage.estimated ? ' (estimated)' : ''}`}
            >
              ◆{formatCredits(log.usage.credits)}
            </span>
          ) : (
            <span
              className="shrink-0 text-[11px] font-mono text-storm tabular-nums"
              title={`in ${log.usage.inputTokens} / out ${log.usage.outputTokens}${log.usage.cacheReadTokens ? ` / cache read ${log.usage.cacheReadTokens}` : ''}${log.usage.estimated ? ' (estimated)' : ''}`}
            >
              ↑
              {formatTokens(
                log.usage.inputTokens +
                  (log.usage.cacheReadTokens ?? 0) +
                  (log.usage.cacheWrite5mTokens ?? 0) +
                  (log.usage.cacheWrite1hTokens ?? 0)
              )}{' '}
              ↓{formatTokens(log.usage.outputTokens)}
            </span>
          ))}
        {log.cost && log.cost.totalUsd > 0 && (
          <span className="shrink-0 text-[11px] font-mono text-aether tabular-nums">
            {formatCostUsd(log.cost.totalUsd)}
          </span>
        )}
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
            title={accountLabel ? `${accountLabel} (${log.accountId})` : log.accountId}
          >
            {accountLabel ?? log.accountId}
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
            {log.model && (
              <>
                <span className="text-fog">{t('logs.model')}</span>
                <span className="font-mono text-steel break-all">{log.model}</span>
              </>
            )}
            {log.usage &&
              (typeof log.usage.credits === 'number' && log.usage.credits > 0 ? (
                <>
                  <span className="text-fog">{t('logs.credits')}</span>
                  <span className="font-mono text-aether tabular-nums">
                    {log.usage.credits.toFixed(4)}
                  </span>
                </>
              ) : (
                <>
                  <span className="text-fog">{t('logs.tokensInput')}</span>
                  <span className="font-mono text-steel tabular-nums">
                    {log.usage.inputTokens.toLocaleString()}
                    {log.usage.estimated && (
                      <span className="text-fog ml-1.5 text-[10px]">({t('logs.estimated')})</span>
                    )}
                  </span>
                  <span className="text-fog">{t('logs.tokensOutput')}</span>
                  <span className="font-mono text-steel tabular-nums">
                    {log.usage.outputTokens.toLocaleString()}
                  </span>
                  {log.usage.cacheReadTokens !== undefined && log.usage.cacheReadTokens > 0 && (
                    <>
                      <span className="text-fog">{t('logs.tokensCacheRead')}</span>
                      <span className="font-mono text-emerald tabular-nums">
                        {log.usage.cacheReadTokens.toLocaleString()}
                      </span>
                    </>
                  )}
                  {log.usage.cacheWrite5mTokens !== undefined &&
                    log.usage.cacheWrite5mTokens > 0 && (
                      <>
                        <span className="text-fog">{t('logs.tokensCacheWrite5m')}</span>
                        <span className="font-mono text-warning tabular-nums">
                          {log.usage.cacheWrite5mTokens.toLocaleString()}
                        </span>
                      </>
                    )}
                  {log.usage.cacheWrite1hTokens !== undefined &&
                    log.usage.cacheWrite1hTokens > 0 && (
                      <>
                        <span className="text-fog">{t('logs.tokensCacheWrite1h')}</span>
                        <span className="font-mono text-warning tabular-nums">
                          {log.usage.cacheWrite1hTokens.toLocaleString()}
                        </span>
                      </>
                    )}
                </>
              ))}
            {log.cost && log.cost.totalUsd > 0 && (
              <>
                <span className="text-fog">{t('logs.cost')}</span>
                <span className="font-mono text-aether tabular-nums">
                  {formatCostUsd(log.cost.totalUsd)}
                  {log.cost.basis === 'credit' ? (
                    <span className="text-fog ml-2 text-[10px]">
                      {log.usage?.credits?.toFixed(4)} × $
                      {(log.cost.creditsUsd / (log.usage?.credits || 1)).toFixed(2)}/credit
                    </span>
                  ) : (
                    <span className="text-fog ml-2 text-[10px]">
                      in {formatCostUsd(log.cost.inputUsd)} / out{' '}
                      {formatCostUsd(log.cost.outputUsd)}
                      {log.cost.cacheReadUsd > 0 && ` / cr ${formatCostUsd(log.cost.cacheReadUsd)}`}
                      {log.cost.cacheWriteUsd > 0 &&
                        ` / cw ${formatCostUsd(log.cost.cacheWriteUsd)}`}
                    </span>
                  )}
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
                <span className="font-mono text-steel break-all" title={log.accountId}>
                  {accountLabel ?? log.accountId}
                  {accountLabel && (
                    <span className="text-fog ml-2 text-[10px]">{log.accountId}</span>
                  )}
                </span>
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

// A grouped block: a clickable summary header plus (when expanded) the group's
// child entries rendered with the same LogRow component used in flat mode, so a
// child row can still expand its own detail panel.
function GroupBlock({
  row,
  expanded,
  expandedKey,
  accountLabels,
  getLogKey,
  onToggle,
  onRowClick,
  onRequestIdClick
}: {
  row: Extract<GroupRow, { type: 'group' }>
  expanded: boolean
  expandedKey: string | null
  accountLabels: Record<string, string>
  getLogKey: (log: LogEntry) => string
  onToggle: () => void
  onRowClick: (key: string) => void
  onRequestIdClick: (rid: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const accountLabel = row.summary.accountId ? accountLabels[row.summary.accountId] : undefined
  // Children read oldest-first so the request lifecycle reads top-down.
  const children = useMemo(() => [...row.entries].sort((a, b) => a.ts - b.ts), [row.entries])

  return (
    <div
      className={`border-l-[3px] ${row.summary.hasError ? 'border-l-red' : 'border-l-emerald'} ${expanded ? 'bg-[color-mix(in_srgb,var(--c-slate)_60%,transparent)]' : ''}`}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
        className={`flex items-center gap-2 px-3 py-1.5 border-b border-charcoal/30 cursor-pointer ${expanded ? '' : 'hover:bg-[color-mix(in_srgb,var(--c-slate)_30%,transparent)]'}`}
      >
        <span
          className={`shrink-0 text-[10px] text-fog transition-transform duration-100 ${expanded ? 'rotate-90' : ''}`}
          aria-hidden="true"
        >
          ▶
        </span>
        <time className="shrink-0 text-[12px] font-mono text-storm w-[60px] tabular-nums">
          {new Date(row.summary.startTime).toLocaleTimeString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          })}
        </time>
        <p className="text-[12px] text-porcelain/90 truncate flex-1 min-w-0">
          {row.summary.message}
        </p>
        {row.summary.usage &&
          (typeof row.summary.usage.credits === 'number' && row.summary.usage.credits > 0 ? (
            <span
              className="shrink-0 text-[11px] font-mono text-storm tabular-nums"
              title={`${row.summary.usage.credits.toFixed(4)} credits${row.summary.usage.estimated ? ' (estimated)' : ''}`}
            >
              ◆{formatCredits(row.summary.usage.credits)}
            </span>
          ) : (
            <span
              className="shrink-0 text-[11px] font-mono text-storm tabular-nums"
              title={`in ${row.summary.usage.inputTokens} / out ${row.summary.usage.outputTokens}${row.summary.usage.cacheReadTokens ? ` / cache read ${row.summary.usage.cacheReadTokens}` : ''}${row.summary.usage.estimated ? ' (estimated)' : ''}`}
            >
              ↑
              {formatTokens(
                row.summary.usage.inputTokens +
                  (row.summary.usage.cacheReadTokens ?? 0) +
                  (row.summary.usage.cacheWrite5mTokens ?? 0) +
                  (row.summary.usage.cacheWrite1hTokens ?? 0)
              )}{' '}
              ↓{formatTokens(row.summary.usage.outputTokens)}
            </span>
          ))}
        {row.summary.cost && row.summary.cost.totalUsd > 0 && (
          <span className="shrink-0 text-[11px] font-mono text-aether tabular-nums">
            {formatCostUsd(row.summary.cost.totalUsd)}
          </span>
        )}
        {row.summary.duration > 0 && (
          <span className="shrink-0 text-[11px] font-mono text-storm tabular-nums">
            {row.summary.duration}ms
          </span>
        )}
        {row.summary.statusCode !== undefined && (
          <span
            className={`shrink-0 text-[11px] font-mono tabular-nums ${statusCodeColor(row.summary.statusCode)}`}
          >
            {row.summary.statusCode}
          </span>
        )}
        {row.summary.accountId && (
          <span
            className="shrink-0 max-w-[160px] truncate text-[11px] font-mono text-fog tabular-nums"
            title={
              accountLabel ? `${accountLabel} (${row.summary.accountId})` : row.summary.accountId
            }
          >
            {accountLabel ?? row.summary.accountId}
          </span>
        )}
        {row.summary.provider && (
          <span className="shrink-0 tag text-[11px]">{row.summary.provider}</span>
        )}
        <span className="shrink-0 text-[10px] font-mono text-fog tabular-nums">
          ({row.summary.count})
        </span>
      </div>

      {expanded && (
        <div className="animate-slide-down">
          {children.map((log) => {
            // Namespace the child key by requestId so two entries that share the
            // same ts/level/category/message (common for repeated upstream logs
            // in a stream) don't collide, and so group-child expand state stays
            // independent of flat-mode expand state.
            const logKey = `${row.requestId}:${getLogKey(log)}`
            const isExpanded = expandedKey === logKey
            return (
              <LogRow
                key={logKey}
                log={log}
                expanded={isExpanded}
                accountLabel={log.accountId ? accountLabels[log.accountId] : undefined}
                onClick={() => onRowClick(logKey)}
                onRequestIdClick={onRequestIdClick}
              />
            )
          })}
          {children.length === 0 && (
            <div className="px-4 py-2 text-[11px] text-fog">{t('logs.noMatch')}</div>
          )}
        </div>
      )}
    </div>
  )
}
