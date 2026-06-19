import { dirname, join } from 'path'
import { mkdir, readdir, rename, unlink, writeFile } from 'fs/promises'
import { randomBytes } from 'crypto'
import type { BaseAccountConfig } from '../types'
import { readJsonFile, sha256Short } from './utils'
import { withLock } from './lockfile'

/**
 * Generic account-file persistence layer.
 *
 * Replaces the 9 near-identical read/write/delete/update blocks that lived in
 * `configStore.ts` (codex, windsurf, trae, openrouter, nvidia, gptWeb, grokWeb,
 * qoder, kiro). Each provider differs only in a handful of knobs; those are
 * captured in {@link AccountStoreConfig}.
 *
 * The atomic-write helpers (`writeJsonFileUnlocked`, `writeAccountFileWithConflict`,
 * `deleteJsonFileLocked`, `updateJsonFileLocked`, `updateJsonFileLockedWithOptionalEmailRename`)
 * previously duplicated at module scope in configStore.ts now live here as private
 * methods — there was no other consumer.
 */

export interface AccountStoreConfig<T extends BaseAccountConfig> {
  /** Absolute directory holding the provider's `*.json` account files. */
  dir: () => string
  /** Lowercase provider label, used in log messages ("Skipping corrupt <provider> account file"). */
  providerLabel: string
  /**
   * Derive the stable account id when the on-disk JSON is missing one.
   * Return the data unchanged when no backfill is needed (codex/windsurf pass identity).
   */
  backfillId: (data: T) => T
  /**
   * Validate/normalize a parsed file. Return `null` to skip the file silently
   * (e.g. openrouter drops files with no apiKey). Throw to warn-and-skip.
   */
  validate?: (data: T) => T | null
  /** Filename base for an account, without extension. Usually `email||label||id`. */
  fileNameSource: (data: T) => string
  /** Strip runtime-only fields (e.g. `path`) before persisting. */
  strip: (data: T) => unknown
  /** When true, update() renames the file if `email` changed (kiro/codex/trae/qoder). */
  renameOnEmailChange?: boolean
}

export class AccountFileStore<T extends BaseAccountConfig> {
  constructor(private readonly spec: AccountStoreConfig<T>) {}

  get directory(): string {
    return this.spec.dir()
  }

  async readAll(): Promise<T[]> {
    const dir = this.spec.dir()
    let files: string[]
    try {
      files = await readdir(dir)
    } catch {
      return []
    }
    const accounts: T[] = []
    for (const file of files) {
      if (!file.endsWith('.json') || file.startsWith('.')) continue
      const filePath = join(dir, file)
      try {
        const data = await readJsonFile<T>(filePath)
        let normalized = this.spec.backfillId(data)
        if (this.spec.validate) {
          const result = this.spec.validate(normalized)
          if (!result) continue
          normalized = result
        }
        if ((normalized as T).enabled === undefined) (normalized as T).enabled = true
        ;(normalized as T).path = filePath
        accounts.push(normalized)
      } catch (err) {
        console.warn(
          `[GatewayHub] Skipping corrupt ${this.spec.providerLabel} account file: ${file}`,
          err
        )
      }
    }
    return accounts
  }

  async write(data: T): Promise<string> {
    const dir = this.spec.dir()
    await mkdir(dir, { recursive: true })
    const fileBase = safeFileName(this.spec.fileNameSource(data)) || 'account'
    const targetPath = join(dir, `${fileBase}.json`)
    return this.writeAccountFileWithConflict(targetPath, data)
  }

  async delete(accountId: string): Promise<boolean> {
    const accounts = await this.readAll()
    const account = accounts.find((a) => a.id === accountId)
    if (!account?.path) return false
    return deleteJsonFileLocked(account.path)
  }

  async update(accountId: string, updates: Partial<T>): Promise<void> {
    const accounts = await this.readAll()
    const account = accounts.find((a) => a.id === accountId)
    if (!account?.path)
      throw new Error(`${this.spec.providerLabel} account not found: ${accountId}`)
    if (this.spec.renameOnEmailChange) {
      await updateJsonFileLockedWithOptionalEmailRename(
        account.path,
        accountId,
        account.email,
        updates as { email?: unknown } & object
      )
    } else {
      await updateJsonFileLocked(account.path, updates as object)
    }
  }

  // --- private: atomic-write helpers (consolidated from configStore.ts) ---
  // `writeJsonFileUnlocked` / `writeJsonFileLocked` live at module scope below;
  // both this class and the update/delete helpers share that single copy.

  private async writeAccountFileWithConflict(targetPath: string, data: T): Promise<string> {
    return withLock(targetPath, async () => {
      const existing = await readJsonFile<BaseAccountConfig>(targetPath).catch(() => null)
      if (existing && existing.id && data.id && existing.id !== data.id) {
        const suffix = targetPath.endsWith('.json')
          ? targetPath.slice(0, -'.json'.length)
          : targetPath
        const altPath = `${suffix}-${sha256Short(data.id)}.json`
        await writeJsonFileLocked(altPath, this.spec.strip(data))
        return altPath
      }
      await writeJsonFileUnlocked(targetPath, this.spec.strip(data))
      return targetPath
    })
  }
}

// --- module-level helpers (the locked read/write/delete core, shared by all stores) ---

async function deleteJsonFileLocked(filePath: string): Promise<boolean> {
  return withLock(filePath, async () => {
    await unlink(filePath)
    return true
  })
}

async function updateJsonFileLocked(filePath: string, updates: object): Promise<void> {
  await withLock(filePath, async () => {
    const data = await readJsonFile<BaseAccountConfig>(filePath)
    Object.assign(data, updates)
    await writeJsonFileUnlocked(filePath, data)
  })
}

async function updateJsonFileLockedWithOptionalEmailRename(
  filePath: string,
  accountId: string,
  previousEmail: string | undefined,
  updates: { email?: unknown } & object
): Promise<void> {
  await withLock(filePath, async () => {
    const data = await readJsonFile<BaseAccountConfig>(filePath)
    Object.assign(data, updates)
    await writeJsonFileUnlocked(filePath, data)

    if (typeof updates.email !== 'string' || updates.email === previousEmail) return

    const newBase = safeFileName(updates.email)
    if (!newBase) return

    const newPath = join(dirname(filePath), `${newBase}.json`)
    await withLock(newPath, async () => {
      const conflict = await readJsonFile<BaseAccountConfig>(newPath).catch(() => null)
      if (!conflict || conflict.id === accountId) {
        await rename(filePath, newPath).catch(() => {})
      }
    })
  })
}

async function writeJsonFileUnlocked(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tmpFile = `${filePath}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmpFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmpFile, filePath)
}

async function writeJsonFileLocked(filePath: string, value: unknown): Promise<void> {
  await withLock(filePath, async () => writeJsonFileUnlocked(filePath, value))
}

export function safeFileName(value: unknown): string {
  return String(value ?? '').replace(/[^a-zA-Z0-9@._-]/g, '_')
}
