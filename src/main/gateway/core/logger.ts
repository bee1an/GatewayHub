import type { GatewayLogEntry } from '../types'

export class GatewayLogger {
  private readonly entries: GatewayLogEntry[] = []
  private readonly maxEntries: number

  constructor(maxEntries = 300) {
    this.maxEntries = maxEntries
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
    const entry: GatewayLogEntry = {
      ts: Date.now(),
      level,
      message,
      provider: meta?.provider,
      accountId: meta?.accountId
    }
    this.entries.push(entry)
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries)

    const prefix = `[GatewayHub]${entry.provider ? `[${entry.provider}]` : ''}${entry.accountId ? `[${entry.accountId}]` : ''}`
    const line = `${prefix} ${message}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }

  getEntries(): GatewayLogEntry[] {
    return [...this.entries]
  }

  replace(entries: GatewayLogEntry[]): void {
    this.entries.splice(0, this.entries.length, ...entries.slice(-this.maxEntries))
  }
}
