import { appendFile, mkdir, rename, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import type { GatewayLogEntry } from '../types'

export interface LogWriterConfig {
  logDir: string
  maxFileSize: number
  maxFiles: number
  flushIntervalMs: number
}

export const DEFAULT_LOG_WRITER_CONFIG: Omit<LogWriterConfig, 'logDir'> = {
  maxFileSize: 5 * 1024 * 1024,
  maxFiles: 5,
  flushIntervalMs: 500
}

export class LogWriter {
  private pending: GatewayLogEntry[] = []
  private flushTimer?: NodeJS.Timeout
  private currentFileSize = 0
  private flushing = false

  constructor(private readonly config: LogWriterConfig) {}

  get logFilePath(): string {
    return join(this.config.logDir, 'gateway.log')
  }

  async initialize(): Promise<void> {
    await mkdir(this.config.logDir, { recursive: true })
    try {
      const s = await stat(this.logFilePath)
      this.currentFileSize = s.size
    } catch {
      this.currentFileSize = 0
    }
  }

  write(entry: GatewayLogEntry): void {
    this.pending.push(entry)
    if (this.pending.length >= 50) {
      void this.flush()
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined
        void this.flush()
      }, this.config.flushIntervalMs)
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.pending.length === 0) return
    this.flushing = true
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }

    const batch = this.pending.splice(0)
    const lines = batch.map((e) => JSON.stringify(e)).join('\n') + '\n'
    const bytes = Buffer.byteLength(lines, 'utf8')

    try {
      if (this.currentFileSize + bytes > this.config.maxFileSize) {
        await this.rotate()
      }
      await appendFile(this.logFilePath, lines, 'utf8')
      this.currentFileSize += bytes
    } catch {
      // 写入失败时丢弃，避免阻塞
    } finally {
      this.flushing = false
    }
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    await this.flush()
  }

  async exportToFile(entries: GatewayLogEntry[], format: 'json' | 'ndjson'): Promise<string> {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const ext = format === 'json' ? 'json' : 'ndjson'
    const exportPath = join(this.config.logDir, `gateway-export-${ts}.${ext}`)
    const content =
      format === 'json'
        ? JSON.stringify(entries, null, 2)
        : entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
    await writeFile(exportPath, content, 'utf8')
    return exportPath
  }

  private async rotate(): Promise<void> {
    const oldest = join(this.config.logDir, `gateway.${this.config.maxFiles}.log`)
    await unlink(oldest).catch(() => {})

    for (let i = this.config.maxFiles - 1; i >= 1; i--) {
      const from = join(this.config.logDir, `gateway.${i}.log`)
      const to = join(this.config.logDir, `gateway.${i + 1}.log`)
      await rename(from, to).catch(() => {})
    }

    await rename(this.logFilePath, join(this.config.logDir, 'gateway.1.log')).catch(() => {})
    this.currentFileSize = 0
  }
}
