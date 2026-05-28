import type { CAC } from 'cac'
import http from 'http'
import { ensureServiceInitialized } from '../bootstrap'
import { CliError, ExitCode } from '../framework/errors'
import { colors, emitSuccess, isJsonMode, printTable } from '../framework/output'
import type { GatewayStatusSnapshot } from '../../main/gateway/types'
import {
  daemonStart,
  daemonStop,
  daemonStatus,
  daemonRestart,
  type DaemonStatus
} from '../daemon/controller'
import { runDaemon } from '../daemon/runner'

const ACTIONS = ['status', 'start', 'stop', 'restart', 'health'] as const
type Action = (typeof ACTIONS)[number]

export function registerGatewayCommands(cli: CAC): void {
  cli
    .command('gateway <action>', 'Gateway lifecycle and status (status|start|stop|restart|health)')
    .option('--host <host>', 'Bind host for start/restart', { default: '127.0.0.1' })
    .option('--port <port>', 'Bind port for start/restart', { default: 9741 })
    .action(async (action: string, options: { host: string; port: number | string }) => {
      if (!ACTIONS.includes(action as Action)) {
        throw new CliError(
          `Unknown gateway action: ${action}. Expected one of ${ACTIONS.join(', ')}.`,
          { code: ExitCode.UsageError, errorCode: 'UNKNOWN_ACTION' }
        )
      }
      const host = String(options.host)
      const port = Number(options.port)
      switch (action as Action) {
        case 'status':
          return runStatus()
        case 'start':
          return runStart(host, port)
        case 'stop':
          return runStop()
        case 'restart':
          return runRestart(host, port)
        case 'health':
          return runHealth()
      }
    })

  // Hidden command: actually run the daemon process. Spawned by `gateway start`.
  cli
    .command('__daemon-run', '', { allowUnknownOptions: true })
    .option('--host <host>', '')
    .option('--port <port>', '')
    .action(async (options: { host: string; port: number | string }) => {
      await runDaemon({ host: String(options.host), port: Number(options.port) })
      // runDaemon registers SIGTERM handlers and keeps the process alive
      await new Promise(() => {
        /* never resolves */
      })
    })
}

async function runStatus(): Promise<void> {
  const daemon = await daemonStatus()
  if (daemon.running && daemon.serviceStatus) {
    emitSuccess({ daemon, service: daemon.serviceStatus }, () =>
      renderRunningStatus(daemon, daemon.serviceStatus as GatewayStatusSnapshot)
    )
    return
  }

  // Daemon not running — fall back to in-process service for a snapshot.
  const service = await ensureServiceInitialized()
  const snapshot = await service.getStatus()
  emitSuccess({ daemon: { running: false }, service: snapshot }, () =>
    renderInprocessStatus(snapshot)
  )
}

async function runStart(host: string, port: number): Promise<void> {
  const result = await daemonStart(host, port)
  emitSuccess(result, () => {
    process.stdout.write(
      `${colors.green('daemon started')} pid=${result.pid} ${result.host}:${result.port}\n`
    )
  })
}

async function runStop(): Promise<void> {
  const result = await daemonStop()
  if (!result.wasRunning) {
    emitSuccess({ stopped: false, wasRunning: false }, () => {
      process.stdout.write(`${colors.gray('daemon was not running')}\n`)
    })
    return
  }
  emitSuccess(result, () => {
    process.stdout.write(`${colors.green('daemon stopped')}\n`)
  })
}

async function runRestart(host: string, port: number): Promise<void> {
  const result = await daemonRestart(host, port)
  emitSuccess(result, () => {
    process.stdout.write(
      `${colors.green('daemon restarted')} pid=${result.pid} ${result.host}:${result.port}\n`
    )
  })
}

async function runHealth(): Promise<void> {
  const daemon = await daemonStatus()
  if (!daemon.running) {
    throw new CliError('Daemon is not running.', {
      code: ExitCode.DaemonUnreachable,
      errorCode: 'DAEMON_NOT_RUNNING'
    })
  }
  const ok = await probeHealth(daemon.host!, daemon.port!)
  emitSuccess({ healthy: ok, host: daemon.host, port: daemon.port }, () => {
    process.stdout.write(
      ok
        ? `${colors.green('healthy')} ${daemon.host}:${daemon.port}\n`
        : `${colors.red('unhealthy')} ${daemon.host}:${daemon.port}\n`
    )
  })
  if (!ok) {
    throw new CliError('Health probe failed.', {
      code: ExitCode.GeneralError,
      errorCode: 'UNHEALTHY'
    })
  }
}

function renderRunningStatus(daemon: DaemonStatus, snapshot: GatewayStatusSnapshot): void {
  if (isJsonMode()) return
  process.stdout.write(`${colors.bold('Daemon')}\n`)
  process.stdout.write(`  state    ${colors.green('running')}\n`)
  process.stdout.write(`  pid      ${daemon.pid}\n`)
  process.stdout.write(`  host     ${daemon.host}\n`)
  process.stdout.write(`  port     ${daemon.port}\n`)
  process.stdout.write(`  internal ${daemon.internalPort}\n`)
  process.stdout.write(`  started  ${daemon.startedAt}\n\n`)
  renderProvidersAndServer(snapshot)
}

function renderInprocessStatus(snapshot: GatewayStatusSnapshot): void {
  if (isJsonMode()) return
  process.stdout.write(`${colors.bold('Daemon')}\n`)
  process.stdout.write(`  state    ${colors.gray('not running')}\n\n`)
  renderProvidersAndServer(snapshot)
}

function renderProvidersAndServer(snapshot: GatewayStatusSnapshot): void {
  const { server, providers, configPath } = snapshot
  process.stdout.write(`${colors.bold('Server')}\n`)
  process.stdout.write(`  url      ${server.url}\n`)
  process.stdout.write(`  apiKeys  ${server.apiKeys.length}\n`)
  process.stdout.write(`  config   ${configPath}\n\n`)

  process.stdout.write(`${colors.bold('Providers')}\n`)
  printTable(providers, [
    { header: 'TYPE', get: (p) => p.providerType },
    { header: 'NAME', get: (p) => p.name },
    { header: 'ENABLED', get: (p) => (p.enabled ? colors.green('yes') : colors.gray('no')) },
    { header: 'STATUS', get: (p) => statusColor(p.status) },
    { header: 'MODELS', get: (p) => String(p.models.length), align: 'right' }
  ])
}

function statusColor(status: string): string {
  if (status === 'ready') return colors.green(status)
  if (status === 'error') return colors.red(status)
  if (status === 'disabled') return colors.gray(status)
  return colors.yellow(status)
}

function probeHealth(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ hostname: host, port, path: '/health', timeout: 3000 }, (res) => {
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
