import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { LogReader } from '../logReader'
import type { GatewayLogEntry } from '../../types'

let dir: string

function entry(partial: Partial<GatewayLogEntry>): GatewayLogEntry {
  return { ts: Date.now(), level: 'info', message: 'm', ...partial }
}

async function seed(file: string, entries: GatewayLogEntry[]): Promise<void> {
  await writeFile(join(dir, file), entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'logreader-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('LogReader.query', () => {
  it('returns newest entries first across rotations', async () => {
    await seed('gateway.1.log', [
      entry({ ts: 100, message: 'old-a' }),
      entry({ ts: 200, message: 'old-b' })
    ])
    await seed('gateway.log', [
      entry({ ts: 300, message: 'new-a' }),
      entry({ ts: 400, message: 'new-b' })
    ])

    const { entries } = await new LogReader(dir).query()
    expect(entries.map((e) => e.message)).toEqual(['new-b', 'new-a', 'old-b', 'old-a'])
  })

  it('filters by level, category, search and since', async () => {
    await seed('gateway.log', [
      entry({ ts: 1, level: 'error', category: 'upstream', message: 'Boom', requestId: 'r1' }),
      entry({ ts: 2, level: 'info', category: 'request', message: 'ok', requestId: 'r1' }),
      entry({ ts: 3, level: 'warn', category: 'upstream', message: 'hmm', provider: 'kiro' }),
      entry({ ts: 4, level: 'debug', message: 'noise' })
    ])

    const reader = new LogReader(dir)
    expect((await reader.query({ level: 'error' })).entries.map((e) => e.message)).toEqual(['Boom'])
    expect((await reader.query({ category: 'upstream' })).entries.map((e) => e.message)).toEqual([
      'hmm',
      'Boom'
    ])
    expect((await reader.query({ search: 'boom' })).entries).toHaveLength(1)
    expect((await reader.query({ since: 2, until: 3 })).entries.map((e) => e.ts)).toEqual([3, 2])
  })

  it('paginates via before cursor and reports truncation', async () => {
    await seed(
      'gateway.log',
      Array.from({ length: 10 }, (_, i) => entry({ ts: i + 1, message: `m${i}` }))
    )
    const reader = new LogReader(dir)

    const page1 = await reader.query({ limit: 4 })
    expect(page1.entries.map((e) => e.ts)).toEqual([10, 9, 8, 7])
    expect(page1.truncated).toBe(true)

    const page2 = await reader.query({ limit: 4, before: page1.nextBefore })
    expect(page2.entries.map((e) => e.ts)).toEqual([6, 5, 4, 3])
  })

  it('skips corrupt lines and missing dir', async () => {
    await writeFile(
      join(dir, 'gateway.log'),
      '{"ts":1,"level":"info","message":"ok"}\n{bad\n',
      'utf8'
    )
    const reader = new LogReader(dir)
    expect((await reader.query()).entries).toHaveLength(1)
    expect((await new LogReader(join(dir, 'nope')).query()).entries).toEqual([])
  })

  it('redacts secrets from stored entries', async () => {
    await seed('gateway.log', [entry({ message: 'key=sk-abcdef1234567890abcdef1234567890' })])
    const { entries } = await new LogReader(dir).query()
    expect(entries[0].message).not.toContain('sk-abcdef1234567890abcdef1234567890')
  })
})

describe('LogReader.requestTrace', () => {
  it('returns the full request lifecycle oldest-first across rotations', async () => {
    await seed('gateway.1.log', [entry({ ts: 10, requestId: 'r1', message: 'start' })])
    await seed('gateway.log', [
      entry({ ts: 50, requestId: 'r1', message: 'end' }),
      entry({ ts: 60, requestId: 'r2', message: 'other' }),
      entry({ ts: 40, requestId: 'r1', message: 'mid' })
    ])

    const trace = await new LogReader(dir).requestTrace('r1')
    expect(trace.map((e) => e.message)).toEqual(['start', 'mid', 'end'])
  })
})
