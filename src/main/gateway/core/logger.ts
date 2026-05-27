import type { GatewayLogEntry, LogCategory } from '../types'
import { LogWriter, type LogWriterConfig } from './logWriter'
import { redactSecrets } from './redact'

export interface LoggerConfig {
  maxEntries: number
  writer?: LogWriterConfig
}

export const DEFAULT_LOGGER_CONFIG: LoggerConfig = {
  maxEntries: 1000
}

export class GatewayLogger {
  private readonly entries: GatewayLogEntry[] = []
  private readonly maxEntries: number
  private writer?: LogWriter

  constructor(private readonly config: LoggerConfig = DEFAULT_LOGGER_CONFIG) {
    this.maxEntries = config.maxEntries
  }

  async initialize(): Promise<void> {
    if (this.config.writer) {
      this.writer = new LogWriter(this.config.writer)
      await this.writer.initialize()
    }
  }

  async shutdown(): Promise<void> {
    await this.writer?.shutdown()
  }

  debug(message: string, meta?: Partial<GatewayLogEntry>): void {
    this.add('debug', message, meta)
  }

  info(message: string, meta?: Partial<GatewayLogEntry>): void {
    this.add('info', message, meta)
  }

  warn(message: string, meta?: Partial<GatewayLogEntry>): void {
    this.add('warn', message, meta)
  }

  error(message: string, meta?: Partial<GatewayLogEntry>): void {
    this.add('error', message, meta)
  }

  add(level: GatewayLogEntry['level'], message: string, meta?: Partial<GatewayLogEntry>): void {
    const { ts: _ts, ...rest } = meta ?? {}
    const rawEntry: GatewayLogEntry = {
      ts: Date.now(),
      level,
      message,
      ...rest
    }
    const entry = redactSecrets(rawEntry)

    this.entries.push(entry)
    if (this.entries.length > this.maxEntries)
      this.entries.splice(0, this.entries.length - this.maxEntries)

    this.writer?.write(entry)

    const parts = ['[GatewayHub]']
    if (entry.category) parts.push(`[${entry.category}]`)
    if (entry.provider) parts.push(`[${entry.provider}]`)
    if (entry.accountId) parts.push(`[${entry.accountId}]`)
    if (entry.requestId) parts.push(`[${entry.requestId.slice(0, 8)}]`)
    const line = `${parts.join('')} ${message}`

    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }

  getEntries(): GatewayLogEntry[] {
    return this.entries.map((e) => redactSecrets(e))
  }

  getEntriesByCategory(category: LogCategory): GatewayLogEntry[] {
    return this.entries.filter((e) => e.category === category).map((e) => redactSecrets(e))
  }

  getEntriesByRequestId(requestId: string): GatewayLogEntry[] {
    return this.entries.filter((e) => e.requestId === requestId).map((e) => redactSecrets(e))
  }

  getLogs(options?: {
    category?: LogCategory
    requestId?: string
    level?: string
    limit?: number
  }): GatewayLogEntry[] {
    let result = this.entries
    if (options?.category) result = result.filter((e) => e.category === options.category)
    if (options?.requestId) result = result.filter((e) => e.requestId === options.requestId)
    if (options?.level) result = result.filter((e) => e.level === options.level)
    if (options?.limit) result = result.slice(-options.limit)
    return result.map((e) => redactSecrets(e))
  }

  async exportLogs(format: 'json' | 'ndjson'): Promise<string> {
    if (!this.writer) throw new Error('Log writer not configured')
    return this.writer.exportToFile(
      this.entries.map((e) => redactSecrets(e)),
      format
    )
  }

  replace(entries: GatewayLogEntry[]): void {
    const sanitized = entries.slice(-this.maxEntries).map((e) => redactSecrets(e))
    this.entries.splice(0, this.entries.length, ...sanitized)
  }
}
