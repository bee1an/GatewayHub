import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'
import type {
  ProviderName,
  UsageDailyEntry,
  UsageDetail,
  UsageReadOptions,
  UsageStats,
  UsageSummary
} from '../types'
import { PricingTable, normalizeModelKey } from './pricing'
import { withLock } from './lockfile'

const STORE_VERSION = 1
const RETENTION_DAYS = 30
const UNKNOWN_ACCOUNT_ID = '_unknown_'

/**
 * Packed token 数组：[input, output, cacheRead, cw5m, cw1h, requests, credits×1e6]
 * - 7 元组比对象省 ~70% JSON 体积；30 天 × 多模型 × 多账户场景下显著
 * - credits 用整数微分（×1e6）保存以避免浮点累加误差，读出时除回去
 * - 旧版 6 元组（无 credits）兼容读入：缺失位补 0
 */
type PackedUsage = [
  input: number,
  output: number,
  cacheRead: number,
  cw5m: number,
  cw1h: number,
  requests: number,
  creditsMicro: number
]

interface ModelEntry {
  packed: PackedUsage
  apiFormat?: 'openai' | 'anthropic'
  provider?: ProviderName
  updatedAt: string
}

type ModelsByModel = Record<string, ModelEntry>
type AccountsByAccountId = Record<string, ModelsByModel>
type DaysByDayKey = Record<string, AccountsByAccountId>

interface UsageStoreFile {
  version: number
  days: DaysByDayKey
}

function emptyStoreFile(): UsageStoreFile {
  return { version: STORE_VERSION, days: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function emptyPacked(): PackedUsage {
  return [0, 0, 0, 0, 0, 0, 0]
}

function addPacked(target: PackedUsage, delta: PackedUsage): void {
  for (let i = 0; i < 7; i++) target[i] += delta[i]
}

function packedFromUsage(usage: UsageStats): PackedUsage {
  const credits = Number.isFinite(usage.credits) ? Math.max(0, usage.credits ?? 0) : 0
  return [
    Math.max(0, Math.trunc(usage.inputTokens || 0)),
    Math.max(0, Math.trunc(usage.outputTokens || 0)),
    Math.max(0, Math.trunc(usage.cacheReadTokens || 0)),
    Math.max(0, Math.trunc(usage.cacheWrite5mTokens || 0)),
    Math.max(0, Math.trunc(usage.cacheWrite1hTokens || 0)),
    1,
    Math.round(credits * 1e6)
  ]
}

function packedToUsage(packed: PackedUsage): UsageStats {
  const credits = packed[6] / 1e6
  const stats: UsageStats = {
    inputTokens: packed[0],
    outputTokens: packed[1],
    cacheReadTokens: packed[2],
    cacheWrite5mTokens: packed[3],
    cacheWrite1hTokens: packed[4]
  }
  if (credits > 0) stats.credits = credits
  return stats
}

function totalTokens(packed: PackedUsage): number {
  return packed[0] + packed[1] + packed[2] + packed[3] + packed[4]
}

function packedCredits(packed: PackedUsage): number {
  return packed[6] / 1e6
}

/** YYYY-MM-DD 本地时区 day key */
export function localDayKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function normalizeStore(value: unknown): UsageStoreFile {
  if (!isRecord(value)) return emptyStoreFile()
  const daysValue = isRecord(value.days) ? value.days : {}
  const days: DaysByDayKey = {}
  for (const [dayKey, accountsRaw] of Object.entries(daysValue)) {
    if (!isRecord(accountsRaw)) continue
    const accounts: AccountsByAccountId = {}
    for (const [accountId, modelsRaw] of Object.entries(accountsRaw)) {
      if (!isRecord(modelsRaw)) continue
      const models: ModelsByModel = {}
      for (const [modelKey, entryRaw] of Object.entries(modelsRaw)) {
        if (!isRecord(entryRaw)) continue
        const packed = entryRaw.packed
        // 兼容 6 元组（旧）和 7 元组（含 creditsMicro）
        if (!Array.isArray(packed) || (packed.length !== 6 && packed.length !== 7)) continue
        const numericPacked: PackedUsage = [
          Math.max(0, Math.trunc(Number(packed[0]) || 0)),
          Math.max(0, Math.trunc(Number(packed[1]) || 0)),
          Math.max(0, Math.trunc(Number(packed[2]) || 0)),
          Math.max(0, Math.trunc(Number(packed[3]) || 0)),
          Math.max(0, Math.trunc(Number(packed[4]) || 0)),
          Math.max(0, Math.trunc(Number(packed[5]) || 0)),
          Math.max(0, Math.trunc(Number(packed[6] ?? 0) || 0))
        ]
        const apiFormat =
          entryRaw.apiFormat === 'openai' || entryRaw.apiFormat === 'anthropic'
            ? entryRaw.apiFormat
            : undefined
        const provider =
          typeof entryRaw.provider === 'string' && entryRaw.provider ? entryRaw.provider : undefined
        const updatedAt =
          typeof entryRaw.updatedAt === 'string' && entryRaw.updatedAt ? entryRaw.updatedAt : ''
        models[modelKey] = { packed: numericPacked, apiFormat, provider, updatedAt }
      }
      if (Object.keys(models).length) accounts[accountId] = models
    }
    if (Object.keys(accounts).length) days[dayKey] = accounts
  }
  return { version: STORE_VERSION, days }
}

function pruneOlderThan(store: UsageStoreFile, cutoffKey: string): boolean {
  let mutated = false
  for (const dayKey of Object.keys(store.days)) {
    if (dayKey < cutoffKey) {
      delete store.days[dayKey]
      mutated = true
    }
  }
  return mutated
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  )
}

export interface UsageStoreOptions {
  filePath: string
  pricing: PricingTable
  now?: () => Date
}

export interface UsageRecordInput {
  accountId?: string
  model?: string
  apiFormat?: 'openai' | 'anthropic'
  provider?: ProviderName
  usage: UsageStats
  timestamp?: Date
}

export class UsageStore {
  private cache: UsageStoreFile | null = null
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly options: UsageStoreOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  private async loadStore(): Promise<UsageStoreFile> {
    if (this.cache) return this.cache
    let raw: string
    try {
      raw = await readFile(this.options.filePath, 'utf8')
    } catch (err) {
      if (isEnoent(err)) {
        this.cache = emptyStoreFile()
        return this.cache
      }
      // 其它错误（权限、IO）不能掩盖；继续抛，避免「读失败 → 写空」覆盖链
      throw err
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // JSON 损坏：和未识别版本一样备份到 .bak.<reason>.<ts> 后回退空 store
      await this.backupCorruptStore('invalid-json')
      this.cache = emptyStoreFile()
      return this.cache
    }

    if (!isRecord(parsed) || parsed.version !== STORE_VERSION) {
      const versionTag =
        isRecord(parsed) &&
        (typeof parsed.version === 'number' || typeof parsed.version === 'string')
          ? String(parsed.version)
          : 'unknown'
      await this.backupCorruptStore(versionTag)
      this.cache = emptyStoreFile()
      return this.cache
    }

    this.cache = normalizeStore(parsed)
    return this.cache
  }

  private async backupCorruptStore(tag: string): Promise<void> {
    const backupPath = `${this.options.filePath}.bak.${tag}.${Date.now()}`
    try {
      await rename(this.options.filePath, backupPath)
    } catch (err) {
      console.warn('[usageStore] failed to back up incompatible store', err)
    }
  }

  private async persistStore(store: UsageStoreFile): Promise<void> {
    await mkdir(dirname(this.options.filePath), { recursive: true })
    const tmpFile = `${this.options.filePath}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmpFile, `${JSON.stringify(store)}\n`, 'utf8')
    await rename(tmpFile, this.options.filePath)
  }

  /** 串行队列：保证多次 record 不互相覆盖 */
  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(task, task)
    this.writeQueue = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  async record(input: UsageRecordInput): Promise<void> {
    const usage = input.usage
    if (!usage) return
    const packed = packedFromUsage(usage)
    // tokens 全 0 + credits 全 0 + 没标记请求时跳过；只要任一非 0 就要落库
    if (totalTokens(packed) === 0 && packedCredits(packed) === 0 && packed[5] === 0) return

    const accountId = (input.accountId || '').trim() || UNKNOWN_ACCOUNT_ID
    const model = normalizeModelKey(input.model || 'unknown')
    const ts = input.timestamp ?? this.now()
    const dayKey = localDayKey(ts)
    const updatedAt = this.now().toISOString()

    await this.enqueueWrite(async () => {
      await withLock(this.options.filePath, async () => {
        // 锁内丢弃缓存重读，避免多进程/多 daemon read-modify-write 覆盖
        this.cache = null
        const store = await this.loadStore()
        const dayAccounts = store.days[dayKey] ?? (store.days[dayKey] = {})
        const accountModels = dayAccounts[accountId] ?? (dayAccounts[accountId] = {})
        const entry =
          accountModels[model] ?? (accountModels[model] = { packed: emptyPacked(), updatedAt })
        addPacked(entry.packed, packed)
        if (input.apiFormat) entry.apiFormat = input.apiFormat
        if (input.provider) entry.provider = input.provider
        entry.updatedAt = updatedAt

        const cutoffKey = localDayKey(addDays(this.now(), -(RETENTION_DAYS - 1)))
        pruneOlderThan(store, cutoffKey)
        await this.persistStore(store)
      })
    })
  }

  async read(options: UsageReadOptions = {}): Promise<UsageDetail> {
    this.cache = null
    const store = await this.loadStore()
    const now = this.now()
    const todayKey = localDayKey(now)
    const sinceKey = options.sinceKey ?? localDayKey(addDays(now, -(RETENTION_DAYS - 1)))
    const untilKey = options.untilKey ?? todayKey
    if (sinceKey > untilKey) {
      return { summary: emptySummary(now.toISOString()), daily: [] }
    }

    const accountFilter = options.accountId?.trim()
    const modelFilter = options.model ? normalizeModelKey(options.model) : undefined
    const providerFilter = options.provider?.trim()

    const daily: UsageDailyEntry[] = []
    for (const dayKey of Object.keys(store.days).sort()) {
      if (dayKey < sinceKey || dayKey > untilKey) continue
      const accounts = store.days[dayKey]
      for (const [accountId, models] of Object.entries(accounts)) {
        if (accountFilter && accountFilter !== accountId) continue
        for (const [model, entry] of Object.entries(models)) {
          if (modelFilter && modelFilter !== model) continue
          if (providerFilter && providerFilter !== entry.provider) continue
          const usageStats = packedToUsage(entry.packed)
          const cost = this.options.pricing.compute(model, usageStats, entry.provider)
          daily.push({
            date: dayKey,
            accountId,
            model,
            provider: entry.provider,
            apiFormat: entry.apiFormat,
            inputTokens: entry.packed[0],
            outputTokens: entry.packed[1],
            cacheReadTokens: entry.packed[2],
            cacheWrite5mTokens: entry.packed[3],
            cacheWrite1hTokens: entry.packed[4],
            credits: packedCredits(entry.packed),
            requests: entry.packed[5],
            costUsd: cost.known ? cost.totalUsd : null,
            costBasis: cost.basis,
            updatedAt: entry.updatedAt
          })
        }
      }
    }

    return { summary: buildSummary(daily, todayKey, now.toISOString()), daily }
  }

  async clear(): Promise<void> {
    await this.enqueueWrite(async () => {
      await withLock(this.options.filePath, async () => {
        this.cache = emptyStoreFile()
        await this.persistStore(this.cache)
      })
    })
  }

  /** 测试用——刷新内存缓存到磁盘前刷新；不在生产路径上调用 */
  async flushForTest(): Promise<void> {
    await this.writeQueue
  }
}

function emptySummary(updatedAt: string): UsageSummary {
  return {
    todayTokens: 0,
    todayCredits: 0,
    todayCostUsd: null,
    last30DaysTokens: 0,
    last30DaysCredits: 0,
    last30DaysCostUsd: null,
    todayInputTokens: 0,
    todayOutputTokens: 0,
    todayCacheReadTokens: 0,
    todayCacheWriteTokens: 0,
    todayRequests: 0,
    updatedAt
  }
}

function buildSummary(daily: UsageDailyEntry[], todayKey: string, updatedAt: string): UsageSummary {
  let todayTokens = 0
  let todayCredits = 0
  let todayInput = 0
  let todayOutput = 0
  let todayCacheRead = 0
  let todayCacheWrite = 0
  let todayRequests = 0
  let totalTokens30 = 0
  let totalCredits30 = 0
  let todayCost = 0
  let todayCostKnown = false
  let total30Cost = 0
  let total30CostKnown = false

  for (const entry of daily) {
    const tokens =
      entry.inputTokens +
      entry.outputTokens +
      entry.cacheReadTokens +
      entry.cacheWrite5mTokens +
      entry.cacheWrite1hTokens
    totalTokens30 += tokens
    totalCredits30 += entry.credits
    if (entry.costUsd !== null) {
      total30Cost += entry.costUsd
      total30CostKnown = true
    }
    if (entry.date === todayKey) {
      todayTokens += tokens
      todayCredits += entry.credits
      todayInput += entry.inputTokens
      todayOutput += entry.outputTokens
      todayCacheRead += entry.cacheReadTokens
      todayCacheWrite += entry.cacheWrite5mTokens + entry.cacheWrite1hTokens
      todayRequests += entry.requests
      if (entry.costUsd !== null) {
        todayCost += entry.costUsd
        todayCostKnown = true
      }
    }
  }

  return {
    todayTokens,
    todayCredits,
    todayCostUsd: todayCostKnown ? todayCost : null,
    last30DaysTokens: totalTokens30,
    last30DaysCredits: totalCredits30,
    last30DaysCostUsd: total30CostKnown ? total30Cost : null,
    todayInputTokens: todayInput,
    todayOutputTokens: todayOutput,
    todayCacheReadTokens: todayCacheRead,
    todayCacheWriteTokens: todayCacheWrite,
    todayRequests,
    updatedAt
  }
}

export function createUsageStore(options: UsageStoreOptions): UsageStore {
  return new UsageStore(options)
}

/** 默认 store 文件路径 */
export function defaultUsageStorePath(configDir: string): string {
  return join(configDir, 'usage-store', 'v1.json')
}
