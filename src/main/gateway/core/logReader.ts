import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import type { GatewayLogEntry } from '../types'
import { redactSecrets } from './redact'

export interface LogQuery {
  level?: string
  category?: string
  requestId?: string
  /** substring match against message/provider/accountId/requestId */
  search?: string
  /** only entries with ts >= since */
  since?: number
  /** only entries with ts <= until */
  until?: number
  /** cursor for pagination: only entries with ts < before */
  before?: number
  /** max entries to return, newest first (default 500) */
  limit?: number
}

export interface LogQueryResult {
  entries: GatewayLogEntry[]
  /** pass back as `before` to fetch the next older page; undefined = no more data */
  nextBefore?: number
  /** true when results may have been truncated by limit */
  truncated: boolean
}

/**
 * Reads the rotated NDJSON log files written by LogWriter
 * (`gateway.log`, `gateway.1.log`, ... `gateway.N.log`) and answers filtered
 * queries. Used for disk-backed log analysis beyond the in-memory ring buffer.
 *
 * Files are scanned newest-first (current file, then oldest rotation). All
 * parsing is defensive: malformed lines are skipped.
 */
export class LogReader {
  constructor(private readonly logDir: string) {}

  /** current + rotated files, newest first */
  private async filesNewestFirst(): Promise<string[]> {
    let names: string[]
    try {
      names = await readdir(this.logDir)
    } catch {
      return []
    }
    const logFiles = names
      .filter((n) => /^gateway(\.\d+)?\.log$/.test(n))
      .map((n) => {
        const m = n.match(/^gateway(?:\.(\d+))?\.log$/)
        return { name: n, rotation: m?.[1] ? Number(m[1]) : 0 }
      })
      .sort((a, b) => a.rotation - b.rotation)
    return logFiles.map((f) => join(this.logDir, f.name))
  }

  private matches(entry: GatewayLogEntry, q: LogQuery): boolean {
    if (q.level && entry.level !== q.level) return false
    if (q.category && entry.category !== q.category) return false
    if (q.requestId && entry.requestId !== q.requestId) return false
    if (q.since !== undefined && entry.ts < q.since) return false
    if (q.until !== undefined && entry.ts > q.until) return false
    if (q.before !== undefined && entry.ts >= q.before) return false
    if (q.search) {
      const needle = q.search.toLowerCase()
      const hay = [entry.message, entry.provider, entry.accountId, entry.requestId, entry.category]
      if (!hay.some((v) => typeof v === 'string' && v.toLowerCase().includes(needle))) {
        return false
      }
    }
    return true
  }

  private async *lines(path: string): AsyncGenerator<GatewayLogEntry> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      return
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        yield JSON.parse(line) as GatewayLogEntry
      } catch {
        /* skip corrupt line */
      }
    }
  }

  /**
   * Filtered query, newest entries first. Stops early once `limit` matches are
   * collected from the newest files — older rotations are only read when needed.
   */
  async query(q: LogQuery = {}): Promise<LogQueryResult> {
    const limit = q.limit ?? 500
    const files = await this.filesNewestFirst()
    const matched: GatewayLogEntry[] = []

    for (const file of files) {
      const perFile: GatewayLogEntry[] = []
      for await (const entry of this.lines(file)) {
        if (this.matches(entry, q)) perFile.push(entry)
      }
      // newest lines are at the end of each file
      perFile.reverse()
      for (const entry of perFile) {
        matched.push(entry)
        if (matched.length >= limit) break
      }
      if (matched.length >= limit) break
    }

    matched.sort((a, b) => b.ts - a.ts)
    const truncated = matched.length >= limit
    return {
      entries: matched.slice(0, limit).map((e) => redactSecrets(e)),
      nextBefore: truncated ? matched[matched.length - 1]?.ts : undefined,
      truncated
    }
  }

  /**
   * All entries for one requestId across all rotations, oldest first —
   * i.e. the full lifecycle trace of a single request.
   */
  async requestTrace(requestId: string): Promise<GatewayLogEntry[]> {
    const files = await this.filesNewestFirst()
    const matched: GatewayLogEntry[] = []
    // oldest rotation first so the array lands in chronological order
    for (const file of [...files].reverse()) {
      for await (const entry of this.lines(file)) {
        if (entry.requestId === requestId) matched.push(entry)
      }
    }
    matched.sort((a, b) => a.ts - b.ts)
    return matched.map((e) => redactSecrets(e))
  }
}
