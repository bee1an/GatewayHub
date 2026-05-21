import { configureCliRuntime } from '../bootstrap'
import { gatewayHubService } from '../../main/gateway/service'
import { startInternalServer } from './internalServer'
import { writePidFile, generateInternalToken, removePidFile } from './pidfile'
import { join } from 'path'
import { getPaths } from '../../main/gateway/core/paths'

export interface DaemonRunOptions {
  host: string
  port: number
}

export async function runDaemon(opts: DaemonRunOptions): Promise<void> {
  configureCliRuntime()

  const internalPort = opts.port + 1
  const internalToken = generateInternalToken()
  const logFile = join(getPaths().home(), '.config', 'gatewayhub', 'logs', 'daemon.log')

  await gatewayHubService.initialize({ skipAutoStart: true })

  // Override server config to use the requested host/port
  const config = (gatewayHubService as any).config
  if (config?.server) {
    config.server.host = opts.host
    config.server.port = opts.port
  }

  await gatewayHubService.start()

  await startInternalServer({ host: opts.host, port: internalPort, token: internalToken })

  await writePidFile({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: '1.0.0',
    host: opts.host,
    port: opts.port,
    internalPort,
    internalToken,
    logFile
  })

  const shutdown = async (): Promise<void> => {
    try {
      await gatewayHubService.stop()
    } catch {
      /* ignore */
    }
    await removePidFile()
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
