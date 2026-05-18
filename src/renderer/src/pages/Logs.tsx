import { useState, useMemo, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
import { usePolling } from '../hooks/usePolling'
import { ToggleFilter } from '../components/ui/ToggleFilter'
import { Button } from '../components/ui/Button'

type LogEntry = { ts: number; level: string; message: string; provider?: string; accountId?: string }

type GatewayStatus = {
  server: { running: boolean }
  providers: Array<{ name: string; enabled: boolean; configured: boolean; status: string; models: string[] }>
  logs: LogEntry[]
}

const LEVEL_COLORS: Record<string, string> = {
  error: 'bg-red',
  warn: 'bg-warning',
  info: 'bg-emerald',
  debug: 'bg-fog',
}

const TIME_RANGES = [
  { value: 'all', label: 'All' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '1h', label: '1h' },
]

function getTimeThreshold(range: string): number {
  if (range === 'all') return 0
  const now = Date.now()
  if (range === '5m') return now - 5 * 60_000
  if (range === '15m') return now - 15 * 60_000
  if (range === '1h') return now - 60 * 60_000
  return 0
}

export default function Logs(): React.JSX.Element {
  const { t } = useTranslation()
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [timeRange, setTimeRange] = useState('all')
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)
  const [live, setLive] = useState(true)

  const { data: status } = usePolling<GatewayStatus>(() => window.api.gateway.status(), live ? 2000 : 0)
  const parentRef = useRef<HTMLDivElement>(null)

  const logs = useMemo(() => {
    const raw = status?.logs ?? []
    const threshold = getTimeThreshold(timeRange)
    const searchLower = search.toLowerCase()

    return [...raw]
      .reverse()
      .filter((l) => {
        if (filter !== 'all' && l.level !== filter) return false
        if (threshold > 0 && l.ts < threshold) return false
        if (searchLower && !l.message.toLowerCase().includes(searchLower) && !(l.provider ?? '').toLowerCase().includes(searchLower) && !(l.accountId ?? '').toLowerCase().includes(searchLower)) return false
        return true
      })
  }, [status?.logs, filter, search, timeRange])

  const virtualizer = useVirtualizer({
    count: logs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: useCallback((index: number) => index === expandedIndex ? 120 : 36, [expandedIndex]),
    overscan: 20,
  })

  return (
    <div className="flex flex-col gap-4 h-[calc(100vh-80px)]">
      <div className="flex items-center justify-between shrink-0">
        <h1 className="section-title">{t('logs.title')}</h1>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => setLive(!live)}
            variant={live ? 'ghost' : 'default'}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${live ? 'bg-emerald animate-pulse-green' : 'bg-fog'}`} />
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
          className="input-base !w-[200px] !py-1.5 !text-[12px]"
        />
        <ToggleFilter
          value={filter}
          onValueChange={setFilter}
          items={[
            { value: 'all', label: t('logs.all') },
            { value: 'info', label: t('logs.info') },
            { value: 'warn', label: t('logs.warn') },
            { value: 'error', label: t('logs.error') },
          ]}
        />
        <ToggleFilter
          value={timeRange}
          onValueChange={setTimeRange}
          items={TIME_RANGES}
        />
        <span className="ml-auto text-[12px] text-fog">{t('logs.entries', { count: logs.length })}</span>
      </div>

      <div ref={parentRef} className="card flex-1 overflow-y-auto min-h-0">
        {logs.length === 0 ? (
          <div className="flex items-center justify-center py-14 text-fog text-[13px]">
            {t('logs.noMatch')}
          </div>
        ) : (
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const log = logs[virtualRow.index]
              const isExpanded = expandedIndex === virtualRow.index
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start}px)` }}
                >
                  <LogRow
                    log={log}
                    expanded={isExpanded}
                    onClick={() => setExpandedIndex(isExpanded ? null : virtualRow.index)}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function LogRow({ log, expanded, onClick }: { log: LogEntry; expanded: boolean; onClick: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const levelColor = LEVEL_COLORS[log.level] ?? 'bg-fog'
  const time = new Date(log.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

  return (
    <div
      className={`cursor-pointer transition-colors duration-75 ${expanded ? 'bg-slate/60' : 'hover:bg-slate/30'}`}
      onClick={onClick}
    >
      <div className="flex items-center gap-3 px-3 py-2 border-b border-charcoal/50">
        <span className={`w-0.5 self-stretch min-h-[16px] rounded-full ${levelColor}`} />
        <time className="shrink-0 text-[12px] font-mono text-fog w-[60px] tabular-nums">{time}</time>
        <span className={`shrink-0 w-10 text-[12px] font-[510] ${
          log.level === 'error' ? 'text-red' : log.level === 'warn' ? 'text-warning' : 'text-fog'
        }`}>
          {log.level}
        </span>
        <p className="text-[12px] text-steel truncate flex-1">{log.message}</p>
        {log.provider && <span className="shrink-0 tag text-[12px]">{log.provider}</span>}
      </div>

      {expanded && (
        <div className="px-4 py-3 border-b border-charcoal/50 animate-slide-down">
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
            <span className="text-fog">{t('logs.time')}</span>
            <span className="font-mono text-steel">{new Date(log.ts).toLocaleString()}.{String(log.ts % 1000).padStart(3, '0')}</span>
            <span className="text-fog">{t('logs.level')}</span>
            <span className="text-steel">{log.level}</span>
            <span className="text-fog">{t('logs.message')}</span>
            <span className="text-steel break-all">{log.message}</span>
            {log.provider && <>
              <span className="text-fog">{t('logs.provider')}</span>
              <span className="text-steel">{log.provider}</span>
            </>}
            {log.accountId && <>
              <span className="text-fog">{t('logs.account')}</span>
              <span className="font-mono text-steel">{log.accountId}</span>
            </>}
          </div>
        </div>
      )}
    </div>
  )
}
