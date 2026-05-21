import { readFile, writeFile, unlink, chmod } from 'fs/promises'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { getPaths } from '../../main/gateway/core/paths'

export interface PidFileData {
  pid: number
  startedAt: string
  version: string
  host: string
  port: number
  internalPort: number
  internalToken: string
  logFile: string
}

function pidFilePath(): string {
  return join(getPaths().home(), '.config', 'gatewayhub', 'gatewayhub.pid')
}

export async function readPidFile(): Promise<PidFileData | null> {
  try {
    const raw = await readFile(pidFilePath(), 'utf8')
    return JSON.parse(raw) as PidFileData
  } catch {
    return null
  }
}

export async function writePidFile(data: PidFileData): Promise<void> {
  const path = pidFilePath()
  await writeFile(path, JSON.stringify(data, null, 2), 'utf8')
  await chmod(path, 0o600)
}

export async function removePidFile(): Promise<void> {
  try {
    await unlink(pidFilePath())
  } catch {
    /* already gone */
  }
}

export function generateInternalToken(): string {
  return randomBytes(24).toString('base64url')
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
