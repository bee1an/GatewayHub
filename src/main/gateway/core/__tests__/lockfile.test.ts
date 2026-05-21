import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { atomicWrite } from '../utils'
import { withLock, LockBusyError } from '../lockfile'

let workDir: string

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'gatewayhub-lock-'))
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

describe('atomicWrite + lockfile', () => {
  it('writes content and creates the file', async () => {
    const file = join(workDir, 'a.json')
    await atomicWrite(file, 'hello')
    expect(await readFile(file, 'utf8')).toBe('hello')
  })

  it('serialises concurrent writes so the final content is always one of the inputs', async () => {
    const file = join(workDir, 'concurrent.json')
    const writers = Array.from({ length: 10 }, (_, i) => atomicWrite(file, `payload-${i}\n`))
    await Promise.all(writers)
    const final = await readFile(file, 'utf8')
    expect(final).toMatch(/^payload-\d+\n$/)
  })

  it('LockBusyError is thrown when the underlying lock cannot be acquired in time', async () => {
    const file = join(workDir, 'busy.json')
    // Hold the lock long enough that even the busy retry window is exhausted.
    const released = withLock(file, async () => {
      await new Promise((resolve) => setTimeout(resolve, 800))
    })
    // Give the first lock time to acquire
    await new Promise((r) => setTimeout(r, 100))
    // Use a tight retry budget for the contender so it gives up quickly.
    await expect(
      withLock(
        file,
        async () => {
          /* never reached */
        },
        { retries: { retries: 2, minTimeout: 20, maxTimeout: 60 } }
      )
    ).rejects.toBeInstanceOf(LockBusyError)
    await released
  })
})
