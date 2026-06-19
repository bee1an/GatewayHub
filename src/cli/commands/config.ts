import type { CAC } from 'cac'
import { join } from 'path'
import { getPaths } from '../../main/gateway/core/paths'
import { ensureServiceInitialized } from '../bootstrap'
import { CliError, ExitCode } from '../framework/errors'
import { colors, emitSuccess, isJsonMode } from '../framework/output'

export function registerConfigCommands(cli: CAC): void {
  cli
    .command('config <action>', 'Config introspection (path|show)')
    .option('--raw', 'Show raw config without redacting secrets')
    .action(async (action: string, options: { raw?: boolean }) => {
      const service = await ensureServiceInitialized()
      if (action === 'path') {
        const home = getPaths().home()
        const dir = join(home, '.config', 'gatewayhub')
        const paths = {
          configPath: service.configPath,
          statePath: service.statePath,
          accountsDir: join(dir, 'kiro', 'accounts'),
          codexAccountsDir: join(dir, 'codex', 'accounts'),
          windsurfAccountsDir: join(dir, 'windsurf', 'accounts'),
          traeAccountsDir: join(dir, 'trae', 'accounts'),
          openrouterAccountsDir: join(dir, 'openrouter', 'accounts'),
          nvidiaAccountsDir: join(dir, 'nvidia', 'accounts'),
          gptWebAccountsDir: join(dir, 'gptWeb', 'accounts'),
          grokWebAccountsDir: join(dir, 'grokWeb', 'accounts'),
          qoderAccountsDir: join(dir, 'qoder', 'accounts'),
          qoderAuthDir: join(dir, 'qoder', 'auth'),
          logsDir: join(dir, 'logs'),
          pidFile: join(dir, 'gatewayhub.pid')
        }
        emitSuccess(paths, () => {
          if (isJsonMode()) return
          for (const [k, v] of Object.entries(paths)) {
            process.stdout.write(`  ${k.padEnd(14)} ${v}\n`)
          }
        })
        return
      }
      if (action === 'show') {
        const status = await service.getStatus()
        const raw = (service as any).config ?? null
        const data = options.raw ? raw : redact(raw)
        emitSuccess(data, () => {
          if (isJsonMode()) return
          process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
          process.stdout.write(
            `${colors.dim(`server.url=${status.server.url}, configPath=${service.configPath}`)}\n`
          )
        })
        return
      }
      throw new CliError(`Unknown config action: ${action}`, {
        code: ExitCode.UsageError,
        errorCode: 'UNKNOWN_ACTION'
      })
    })
}

function redact(input: any): any {
  if (!input || typeof input !== 'object') return input
  const clone = JSON.parse(JSON.stringify(input))
  if (Array.isArray(clone.server?.apiKeys)) {
    for (const k of clone.server.apiKeys) {
      if (k.key) k.key = `${String(k.key).slice(0, 8)}…${String(k.key).slice(-4)}`
    }
  }
  return clone
}
