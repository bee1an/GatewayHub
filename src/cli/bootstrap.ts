import { setPathStrategy } from '../main/gateway/core/paths'
import { setCliLoginSink } from '../main/gateway/events/cliLoginEvents'
import { homedir } from 'os'
import { join } from 'path'
import { gatewayHubService } from '../main/gateway/service'

let initialized: Promise<void> | null = null

export function configureCliRuntime(): void {
  setPathStrategy({
    home: () => homedir(),
    userData: () => join(homedir(), '.config', 'gatewayhub')
  })

  setCliLoginSink({
    emit: (event) => {
      if (event.type === 'stdout') process.stdout.write(event.text)
      else if (event.type === 'stderr') process.stderr.write(event.text)
      else if (event.type === 'error') process.stderr.write(`${event.message}\n`)
    }
  })

  // Service-level logger uses console.log; CLI must keep stdout clean
  // (especially in --json mode). Redirect all console output to stderr.
  const writeStderr = (...args: unknown[]): void => {
    process.stderr.write(`${args.map(formatConsoleArg).join(' ')}\n`)
  }
  console.log = writeStderr
  console.info = writeStderr
  console.warn = writeStderr
  console.error = writeStderr
  console.debug = writeStderr
}

function formatConsoleArg(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export async function ensureServiceInitialized(): Promise<typeof gatewayHubService> {
  if (!initialized) {
    initialized = gatewayHubService.initialize({ skipAutoStart: true })
  }
  await initialized
  return gatewayHubService
}
