import { spawn } from 'child_process'
import { open, mkdir } from 'fs/promises'
import { join, resolve } from 'path'
import { getPaths } from '../../main/gateway/core/paths'
import { readPidFile, isProcessAlive } from './pidfile'
import http from 'http'

export interface SpawnDaemonOptions {
  host: string
  port: number
}

export async function spawnDaemon(opts: SpawnDaemonOptions): Promise<void> {
  const logsDir = join(getPaths().home(), '.config', 'gatewayhub', 'logs')
  await mkdir(logsDir, { recursive: true })
  const logPath = join(logsDir, 'daemon.log')
  const logFd = await open(logPath, 'a')

  const cliEntry = resolve(__dirname, 'cli.js')
  const child = spawn(
    process.execPath,
    [cliEntry, '__daemon-run', '--host', opts.host, '--port', String(opts.port)],
    {
      detached: true,
      stdio: ['ignore', logFd.fd, logFd.fd],
      env: { ...process.env, GATEWAYHUB_DAEMON: '1' }
    }
  )
  child.unref()

  const ok = await waitForHealth(opts.host, opts.port, 5000)
  await logFd.close()

  if (!ok) {
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
    throw new Error(`Daemon failed to start within 5 seconds. Check ${logPath}`)
  }
}

export async function isDaemonRunning(): Promise<boolean> {
  const pid = await readPidFile()
  if (!pid) return false
  return isProcessAlive(pid.pid)
}

async function waitForHealth(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await probeHealth(host, port)
    if (ok) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

function probeHealth(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ hostname: host, port, path: '/health', timeout: 1000 }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}
