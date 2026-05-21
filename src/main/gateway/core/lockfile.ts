import { dirname, basename, join } from 'path'
import { mkdir, writeFile, stat } from 'fs/promises'
import lockfile from 'proper-lockfile'

export class LockBusyError extends Error {
  readonly code = 'LOCK_BUSY'
  constructor(filePath: string, cause?: unknown) {
    super(`Configuration file is busy, please retry: ${filePath}`)
    this.name = 'LockBusyError'
    if (cause instanceof Error) this.stack += `\nCaused by: ${cause.stack}`
  }
}

const LOCK_OPTIONS: Parameters<typeof lockfile.lock>[1] = {
  retries: { retries: 50, factor: 1.2, minTimeout: 25, maxTimeout: 250 },
  stale: 10000,
  realpath: false
}

async function ensureSentinel(filePath: string): Promise<string> {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true })
  const sentinel = join(dir, `.${basename(filePath)}.lockref`)
  try {
    await stat(sentinel)
  } catch {
    await writeFile(sentinel, '', 'utf8')
  }
  return sentinel
}

export async function withLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  overrides?: Partial<Parameters<typeof lockfile.lock>[1]>
): Promise<T> {
  const sentinel = await ensureSentinel(filePath)
  let release: () => Promise<void>
  try {
    release = await lockfile.lock(sentinel, { ...LOCK_OPTIONS, ...overrides })
  } catch (err) {
    throw new LockBusyError(filePath, err)
  }
  try {
    return await fn()
  } finally {
    try {
      await release()
    } catch {
      /* lock released by stale timeout - ignore */
    }
  }
}
