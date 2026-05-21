import { readPidFile, removePidFile, isProcessAlive } from './pidfile'
import { spawnDaemon } from './spawn'
import { internalGet, internalPost } from './internalClient'
import { CliError, ExitCode } from '../framework/errors'

export interface DaemonStatus {
  running: boolean
  pid?: number
  host?: string
  port?: number
  internalPort?: number
  startedAt?: string
  serviceStatus?: any
}

export async function daemonStart(host: string, port: number): Promise<DaemonStatus> {
  const existing = await readPidFile()
  if (existing && isProcessAlive(existing.pid)) {
    throw new CliError(
      `Daemon already running (pid ${existing.pid}) on ${existing.host}:${existing.port}`,
      { code: ExitCode.GeneralError, errorCode: 'DAEMON_ALREADY_RUNNING' }
    )
  }
  if (existing) {
    await removePidFile()
  }

  await spawnDaemon({ host, port })

  const pidData = await readPidFile()
  return {
    running: true,
    pid: pidData?.pid,
    host: pidData?.host ?? host,
    port: pidData?.port ?? port,
    internalPort: pidData?.internalPort,
    startedAt: pidData?.startedAt
  }
}

export async function daemonStop(): Promise<{ stopped: boolean; wasRunning: boolean }> {
  const pidData = await readPidFile()
  if (!pidData) {
    return { stopped: false, wasRunning: false }
  }

  if (!isProcessAlive(pidData.pid)) {
    await removePidFile()
    return { stopped: true, wasRunning: false }
  }

  // Try graceful shutdown via internal endpoint
  try {
    await internalPost('/__internal/shutdown', {
      host: pidData.host,
      port: pidData.internalPort,
      token: pidData.internalToken,
      timeout: 3000
    })
  } catch {
    /* endpoint may already be down */
  }

  // Wait up to 3s for process to exit
  if (await waitForExit(pidData.pid, 3000)) {
    await removePidFile()
    return { stopped: true, wasRunning: true }
  }

  // SIGTERM fallback
  try {
    process.kill(pidData.pid, 'SIGTERM')
  } catch {
    /* ignore */
  }
  if (await waitForExit(pidData.pid, 3000)) {
    await removePidFile()
    return { stopped: true, wasRunning: true }
  }

  // SIGKILL last resort
  try {
    process.kill(pidData.pid, 'SIGKILL')
  } catch {
    /* ignore */
  }
  await removePidFile()
  return { stopped: true, wasRunning: true }
}

export async function daemonStatus(): Promise<DaemonStatus> {
  const pidData = await readPidFile()
  if (!pidData) {
    return { running: false }
  }

  if (!isProcessAlive(pidData.pid)) {
    await removePidFile()
    return { running: false }
  }

  // Fetch service status from internal endpoint
  let serviceStatus: any = null
  try {
    const res = await internalGet('/__internal/status', {
      host: pidData.host,
      port: pidData.internalPort,
      token: pidData.internalToken,
      timeout: 5000
    })
    if (res.status === 200) serviceStatus = res.body
  } catch {
    /* daemon alive but internal endpoint unreachable */
  }

  return {
    running: true,
    pid: pidData.pid,
    host: pidData.host,
    port: pidData.port,
    internalPort: pidData.internalPort,
    startedAt: pidData.startedAt,
    serviceStatus
  }
}

export async function daemonRestart(host: string, port: number): Promise<DaemonStatus> {
  await daemonStop()
  return daemonStart(host, port)
}

export async function notifyDaemonReload(): Promise<boolean> {
  const pidData = await readPidFile()
  if (!pidData || !isProcessAlive(pidData.pid)) return false
  try {
    const res = await internalPost('/__internal/reload', {
      host: pidData.host,
      port: pidData.internalPort,
      token: pidData.internalToken,
      timeout: 3000
    })
    return res.status === 200
  } catch {
    return false
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return !isProcessAlive(pid)
}
