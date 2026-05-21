import { cac } from 'cac'
import { setGlobalOptions } from './output'

export interface AppOptions {
  json?: boolean
  noColor?: boolean
}

export function createApp(): ReturnType<typeof cac> {
  const cli = cac('gatewayhub')
  cli.option('--json', 'Output JSON for machine consumption')
  cli.option('--no-color', 'Disable color output')
  cli.help()
  cli.version(readVersion())
  return cli
}

export function syncGlobalOptions(parsedOptions: Record<string, unknown>): void {
  setGlobalOptions({
    json: parsedOptions.json === true,
    color: parsedOptions.color !== false
  })
}

function readVersion(): string {
  try {
    // Resolved at build time via Rollup virtual import; fall back to env in dev.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../../../package.json')
    return pkg.version ?? '0.0.0'
  } catch {
    return process.env.npm_package_version ?? '0.0.0'
  }
}
