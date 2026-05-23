import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis
} from 'recharts'
import { usePolling } from '../hooks/usePolling'
import { Button } from '../components/ui/Button'
import { ToggleFilter } from '../components/ui/ToggleFilter'
import { formatCostUsd, formatCredits, formatTokens } from '../utils/format'

type UsageDailyEntry = {
  date: string
  accountId: string
  model: string
  provider?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
  credits: number
  requests: number
  costUsd: number | null
  costBasis: 'credit' | 'token' | 'none'
}

type UsageDetail = {
  summary: {
    todayTokens: number
    todayCredits: number
    todayCostUsd: number | null
    last30DaysTokens: number
    last30DaysCredits: number
    last30DaysCostUsd: number | null
    todayInputTokens: number
    todayOutputTokens: number
    todayCacheReadTokens: number
    todayCacheWriteTokens: number
    todayRequests: number
    updatedAt: string
  }
  daily: UsageDailyEntry[]
}

const SLICE_COLORS = [
  '#5b9dff', // aether
  '#22d3ee', // cyan
  '#34d399', // emerald
  '#a78bfa', // violet
  '#f59e0b', // warning
  '#f472b6', // amethyst-ish
  '#94a3b8', // steel
  '#fb7185'
]

type Range = '7d' | '30d'

export interface UsageProps {
  /** 限定为单个网关的用量；不传则显示所有网关 */
  provider?: string
  /** 自定义页头标题/描述；嵌入 GatewayDetail tab 时可去掉外层标题 */
  hideHeader?: boolean
  /** accountId → 友好名（email/label）的映射，由父组件传入；缺失则显示 id */
  accountLabels?: Record<string, string>
}

export default function Usage(props: UsageProps = {}): React.JSX.Element {
  const { provider, hideHeader, accountLabels } = props
  const { t } = useTranslation()
  const [range, setRange] = useState<Range>('30d')
  const { data: detail, refresh } = usePolling<UsageDetail>(
    () => window.api.gateway.readUsage(provider ? { provider } : undefined),
    10_000
  )
  const [busy, setBusy] = useState(false)

  const filtered = useMemo(() => {
    if (!detail) return [] as UsageDailyEntry[]
    if (range === '30d') return detail.daily
    const cutoff = todayMinusDaysKey(6)
    return detail.daily.filter((entry) => entry.date >= cutoff)
  }, [detail, range])

  const dailyTrend = useMemo(() => buildDailyTrend(filtered, range), [filtered, range])
  const byModel = useMemo(() => buildBreakdown(filtered, 'model'), [filtered])
  const byAccount = useMemo(() => buildBreakdown(filtered, 'accountId'), [filtered])

  const summary = detail?.summary
  const monthTokens = useMemo(
    () =>
      filtered.reduce(
        (s, e) =>
          s +
          e.inputTokens +
          e.outputTokens +
          e.cacheReadTokens +
          e.cacheWrite5mTokens +
          e.cacheWrite1hTokens,
        0
      ),
    [filtered]
  )
  const monthCredits = useMemo(() => filtered.reduce((s, e) => s + (e.credits || 0), 0), [filtered])
  const monthCost = useMemo(() => sumCost(filtered), [filtered])
  const monthRequests = useMemo(() => filtered.reduce((s, e) => s + e.requests, 0), [filtered])
  const cacheHitRate = useMemo(() => calcCacheHitRate(filtered), [filtered])
  const showCredits = monthCredits > 0 || (summary?.todayCredits ?? 0) > 0

  async function handleClear(): Promise<void> {
    if (!window.confirm(t('usage.clearConfirm'))) return
    setBusy(true)
    try {
      await window.api.gateway.clearUsage()
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 animate-fade-in">
      <div className="flex items-center justify-between">
        {hideHeader ? (
          <div />
        ) : (
          <div>
            <h1 className="section-title">{t('usage.title')}</h1>
            <p className="section-desc">{t('usage.desc')}</p>
          </div>
        )}
        <div className="flex items-center gap-2">
          <ToggleFilter
            value={range}
            onValueChange={(v) => setRange(v as Range)}
            items={[
              { value: '7d', label: t('usage.range7d') },
              { value: '30d', label: t('usage.range30d') }
            ]}
          />
          <Button onClick={() => refresh()} variant="ghost" size="sm">
            <span className="i-ph-arrows-clockwise text-[13px]" aria-hidden="true" />
            {t('usage.refresh')}
          </Button>
          {!provider && (
            <Button onClick={handleClear} variant="ghost" size="sm" disabled={busy}>
              <span className="i-ph-trash text-[13px]" aria-hidden="true" />
              {t('usage.clear')}
            </Button>
          )}
        </div>
      </div>

      {/* 顶部摘要：Kiro 用 credit 计费时显示 credits；其他网关显示 tokens */}
      <div
        className={`grid grid-cols-2 ${showCredits ? 'lg:grid-cols-4' : 'lg:grid-cols-5'} gap-3`}
      >
        {showCredits ? (
          <>
            <SummaryCard
              icon="i-ph-coin-vertical"
              label={t('usage.todayCredits')}
              value={formatCredits(summary?.todayCredits ?? 0)}
              accent="violet"
            />
            <SummaryCard
              icon="i-ph-currency-dollar"
              label={t('usage.todayCost')}
              value={formatCostUsd(summary?.todayCostUsd ?? undefined)}
              accent="aether"
            />
            <SummaryCard
              icon="i-ph-coins"
              label={t('usage.monthCredits')}
              value={formatCredits(monthCredits)}
              accent="emerald"
            />
            <SummaryCard
              icon="i-ph-coin"
              label={t('usage.monthCost')}
              value={formatCostUsd(monthCost ?? undefined)}
              accent="cyan"
            />
          </>
        ) : (
          <>
            <SummaryCard
              icon="i-ph-stack"
              label={t('usage.todayTokens')}
              value={formatTokens(summary?.todayTokens ?? 0)}
              accent="violet"
            />
            <SummaryCard
              icon="i-ph-currency-dollar"
              label={t('usage.todayCost')}
              value={formatCostUsd(summary?.todayCostUsd ?? undefined)}
              accent="aether"
            />
            <SummaryCard
              icon="i-ph-stack-simple"
              label={t('usage.monthTokens')}
              value={formatTokens(monthTokens)}
              accent="emerald"
            />
            <SummaryCard
              icon="i-ph-coin"
              label={t('usage.monthCost')}
              value={formatCostUsd(monthCost ?? undefined)}
              accent="cyan"
            />
            <SummaryCard
              icon="i-ph-database"
              label={t('usage.cacheHitRate')}
              value={cacheHitRate !== null ? `${cacheHitRate}%` : t('usage.noData')}
              accent="amethyst"
            />
          </>
        )}
      </div>

      {/* 主体：左趋势右饼图 */}
      {monthRequests === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <ChartCard title={showCredits ? t('usage.dailyCreditsTrend') : t('usage.dailyTrend')}>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={dailyTrend} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--c-charcoal)"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10, fill: 'var(--c-storm)' }}
                    tickFormatter={shortDate}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: 'var(--c-storm)' }}
                    tickFormatter={(v) => (showCredits ? formatCredits(v) : formatTokens(v))}
                  />
                  <RechartsTooltip
                    contentStyle={tooltipStyle}
                    itemStyle={tooltipItemStyle}
                    labelStyle={tooltipLabelStyle}
                    cursor={tooltipCursorStyle}
                    formatter={(value, name) => [
                      showCredits ? formatCredits(toNumber(value)) : formatTokens(toNumber(value)),
                      showCredits ? t('usage.credits') : tokenLegend(String(name), t)
                    ]}
                    labelFormatter={(label) => String(label)}
                  />
                  {!showCredits && (
                    <Legend
                      wrapperStyle={{ fontSize: 11, color: 'var(--c-storm)' }}
                      formatter={(value) => tokenLegend(String(value), t)}
                    />
                  )}
                  {showCredits ? (
                    <Bar dataKey="credits" fill="#a78bfa" />
                  ) : (
                    <>
                      <Bar dataKey="input" stackId="t" fill="#5b9dff" />
                      <Bar dataKey="cacheRead" stackId="t" fill="#22d3ee" />
                      <Bar dataKey="cacheWrite" stackId="t" fill="#a78bfa" />
                      <Bar dataKey="output" stackId="t" fill="#34d399" />
                    </>
                  )}
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title={t('usage.dailyCost')}>
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={dailyTrend} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--c-charcoal)"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10, fill: 'var(--c-storm)' }}
                    tickFormatter={shortDate}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: 'var(--c-storm)' }}
                    tickFormatter={(v) => formatCostUsd(v)}
                  />
                  <RechartsTooltip
                    contentStyle={tooltipStyle}
                    itemStyle={tooltipItemStyle}
                    labelStyle={tooltipLabelStyle}
                    cursor={{ stroke: 'var(--c-charcoal)', strokeWidth: 1 }}
                    formatter={(value) => [formatCostUsd(toNumber(value)), t('usage.cost')]}
                    labelFormatter={(label) => String(label)}
                  />
                  <Line
                    type="monotone"
                    dataKey="cost"
                    stroke="#22d3ee"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          <BreakdownCard
            byModel={byModel}
            byAccount={byAccount}
            modelLabel={t('usage.model')}
            accountLabel={t('usage.account')}
            unknownAccountLabel={t('usage.unknownAccount')}
            byModelTitle={t('usage.byModel')}
            byAccountTitle={t('usage.byAccount')}
            useCredits={showCredits}
            accountLabels={accountLabels}
          />
        </>
      )}
    </div>
  )
}

function SummaryCard({
  icon,
  label,
  value,
  accent
}: {
  icon: string
  label: string
  value: string
  accent: string
}): React.JSX.Element {
  return (
    <div
      className="card px-3 py-2.5 flex flex-col gap-1.5 border-l-[2px]"
      style={{ borderLeftColor: `var(--c-${accent})` }}
    >
      <div className="flex items-center gap-1.5">
        <span className={`${icon} text-[12px] text-${accent}`} aria-hidden="true" />
        <span className="text-[10px] text-storm font-medium uppercase tracking-[0.5px]">
          {label}
        </span>
      </div>
      <span className="text-[18px] font-[650] text-porcelain tabular-nums leading-none tracking-[-0.3px]">
        {value}
      </span>
    </div>
  )
}

function ChartCard({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="card px-3 py-3 flex flex-col gap-2">
      <span className="text-[11px] text-storm font-medium uppercase tracking-[0.5px]">{title}</span>
      <div className="min-h-[240px]">{children}</div>
    </div>
  )
}

type BreakdownEntry = {
  key: string
  totalTokens: number
  totalCredits: number
  cost: number | null
}

function BreakdownCard({
  byModel,
  byAccount,
  modelLabel,
  accountLabel,
  unknownAccountLabel,
  byModelTitle,
  byAccountTitle,
  useCredits,
  accountLabels
}: {
  byModel: BreakdownEntry[]
  byAccount: BreakdownEntry[]
  modelLabel: string
  accountLabel: string
  unknownAccountLabel: string
  byModelTitle: string
  byAccountTitle: string
  useCredits: boolean
  accountLabels?: Record<string, string>
}): React.JSX.Element {
  const [tab, setTab] = useState<'model' | 'account'>('model')
  const data = tab === 'model' ? byModel : byAccount
  const fallbackLabel = tab === 'account' ? unknownAccountLabel : undefined
  const keyLabel = tab === 'model' ? modelLabel : accountLabel

  // account tab：优先用父级传入的 email/label 映射
  const resolveLabel = (key: string): string => {
    if (tab === 'account' && key !== '_unknown_' && accountLabels?.[key]) return accountLabels[key]
    return labelize(key, fallbackLabel)
  }

  const valueOf = (e: BreakdownEntry): number => (useCredits ? e.totalCredits : e.totalTokens)
  const formatValue = (n: number): string => (useCredits ? formatCredits(n) : formatTokens(n))

  const total = data.reduce((s, e) => s + valueOf(e), 0)
  const display = data.slice(0, 8)
  const others = data.slice(8)
  const otherTokens = others.reduce((s, e) => s + e.totalTokens, 0)
  const otherCredits = others.reduce((s, e) => s + e.totalCredits, 0)
  const otherCost = others.reduce(
    (acc: number | null, e) => (e.cost === null ? acc : (acc ?? 0) + e.cost),
    others.length && others.some((e) => e.cost !== null) ? 0 : null
  )
  const list = [
    ...display,
    ...((useCredits ? otherCredits : otherTokens) > 0
      ? [
          {
            key: 'Other',
            totalTokens: otherTokens,
            totalCredits: otherCredits,
            cost: otherCost
          } as BreakdownEntry
        ]
      : [])
  ]
  const pieData = list.map((entry) => ({
    name: resolveLabel(entry.key),
    value: valueOf(entry)
  }))

  return (
    <div className="card px-3 py-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-storm font-medium uppercase tracking-[0.5px]">
          {tab === 'model' ? byModelTitle : byAccountTitle}
        </span>
        <ToggleFilter
          value={tab}
          onValueChange={(v) => setTab(v as 'model' | 'account')}
          items={[
            { value: 'model', label: modelLabel },
            { value: 'account', label: accountLabel }
          ]}
        />
      </div>
      <div className="grid grid-cols-[200px_1fr] gap-3 items-center">
        <div className="min-h-[200px]">
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={pieData}
                dataKey="value"
                nameKey="name"
                innerRadius={40}
                outerRadius={72}
                paddingAngle={2}
                stroke="none"
                isAnimationActive={false}
              >
                {pieData.map((_, i) => (
                  <Cell key={i} fill={SLICE_COLORS[i % SLICE_COLORS.length]} />
                ))}
              </Pie>
              <RechartsTooltip
                contentStyle={tooltipStyle}
                itemStyle={tooltipItemStyle}
                labelStyle={tooltipLabelStyle}
                formatter={(value) => formatValue(toNumber(value))}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="flex flex-col gap-1.5 min-h-0 overflow-y-auto max-h-[200px]">
          {list.map((entry, i) => {
            const v = valueOf(entry)
            const pct = total > 0 ? (v / total) * 100 : 0
            return (
              <div key={entry.key} className="flex items-center gap-2 text-[11px]">
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: SLICE_COLORS[i % SLICE_COLORS.length] }}
                />
                <span
                  className="text-porcelain font-medium truncate flex-1"
                  title={resolveLabel(entry.key)}
                >
                  {resolveLabel(entry.key)}
                </span>
                <span className="text-storm tabular-nums shrink-0">
                  {formatValue(valueOf(entry))}
                </span>
                <span className="text-fog tabular-nums shrink-0 w-[34px] text-right">
                  {pct.toFixed(0)}%
                </span>
              </div>
            )
          })}
          {list.length === 0 && <span className="text-[11px] text-fog">{keyLabel} · 0</span>}
        </div>
      </div>
    </div>
  )
}

function EmptyState(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="card px-6 py-12 flex flex-col items-center justify-center text-center gap-2">
      <span className="i-ph-chart-line text-[28px] text-fog" aria-hidden="true" />
      <span className="text-[13px] text-porcelain font-medium">{t('usage.noData')}</span>
      <span className="text-[11px] text-fog">{t('usage.noDataHint')}</span>
    </div>
  )
}

const tooltipStyle = {
  backgroundColor: 'var(--c-graphite)',
  border: '1px solid var(--c-charcoal)',
  borderRadius: 6,
  fontSize: 11,
  color: 'var(--c-porcelain)',
  padding: '6px 8px',
  boxShadow: 'var(--shadow-subtle)'
} as const

const tooltipItemStyle = {
  color: 'var(--c-porcelain)',
  padding: '1px 0',
  fontSize: 11
} as const

const tooltipLabelStyle = {
  color: 'var(--c-storm)',
  fontSize: 10,
  fontWeight: 500,
  marginBottom: 4
} as const

const tooltipCursorStyle = { fill: 'var(--c-charcoal)', fillOpacity: 0.4 } as const

function tokenLegend(key: string, t: (k: string) => string): string {
  switch (key) {
    case 'input':
      return t('usage.inputTokens')
    case 'output':
      return t('usage.outputTokens')
    case 'cacheRead':
      return t('usage.cacheRead')
    case 'cacheWrite':
      return t('usage.cacheWrite')
    default:
      return key
  }
}

function shortDate(value: string): string {
  // YYYY-MM-DD → MM-DD
  return value.length >= 10 ? value.slice(5) : value
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function todayMinusDaysKey(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return localDayKey(d)
}

function localDayKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

type DailyTrendPoint = {
  date: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  credits: number
  cost: number
}

function buildDailyTrend(entries: UsageDailyEntry[], range: Range): DailyTrendPoint[] {
  const days = range === '7d' ? 7 : 30
  const map = new Map<string, DailyTrendPoint>()
  for (let i = days - 1; i >= 0; i--) {
    const key = todayMinusDaysKey(i)
    map.set(key, {
      date: key,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      credits: 0,
      cost: 0
    })
  }
  for (const entry of entries) {
    const point = map.get(entry.date)
    if (!point) continue
    point.input += entry.inputTokens
    point.output += entry.outputTokens
    point.cacheRead += entry.cacheReadTokens
    point.cacheWrite += entry.cacheWrite5mTokens + entry.cacheWrite1hTokens
    point.credits += entry.credits || 0
    if (entry.costUsd !== null) point.cost += entry.costUsd
  }
  return [...map.values()]
}

function buildBreakdown(
  entries: UsageDailyEntry[],
  field: 'model' | 'accountId'
): BreakdownEntry[] {
  const map = new Map<string, { totalTokens: number; totalCredits: number; cost: number | null }>()
  for (const entry of entries) {
    const key = entry[field] || 'unknown'
    const tokens =
      entry.inputTokens +
      entry.outputTokens +
      entry.cacheReadTokens +
      entry.cacheWrite5mTokens +
      entry.cacheWrite1hTokens
    const current = map.get(key) ?? { totalTokens: 0, totalCredits: 0, cost: null }
    current.totalTokens += tokens
    current.totalCredits += entry.credits || 0
    if (entry.costUsd !== null) {
      current.cost = (current.cost ?? 0) + entry.costUsd
    }
    map.set(key, current)
  }
  return [...map.entries()]
    .map(([key, v]) => ({
      key,
      totalTokens: v.totalTokens,
      totalCredits: v.totalCredits,
      cost: v.cost
    }))
    .filter((e) => e.totalTokens > 0 || e.totalCredits > 0)
    .sort((a, b) => b.totalCredits - a.totalCredits || b.totalTokens - a.totalTokens)
}

function sumCost(entries: UsageDailyEntry[]): number | null {
  let total = 0
  let known = false
  for (const entry of entries) {
    if (entry.costUsd !== null) {
      total += entry.costUsd
      known = true
    }
  }
  return known ? total : null
}

function calcCacheHitRate(entries: UsageDailyEntry[]): number | null {
  let cacheRead = 0
  let inputSide = 0
  for (const entry of entries) {
    cacheRead += entry.cacheReadTokens
    inputSide +=
      entry.inputTokens +
      entry.cacheReadTokens +
      entry.cacheWrite5mTokens +
      entry.cacheWrite1hTokens
  }
  if (inputSide === 0) return null
  return Math.round((cacheRead / inputSide) * 100)
}

function labelize(key: string, fallback?: string): string {
  if (key === '_unknown_' && fallback) return fallback
  return key
}
