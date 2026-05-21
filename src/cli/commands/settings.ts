import type { CAC } from 'cac'
import { ensureServiceInitialized } from '../bootstrap'
import { CliError, ExitCode } from '../framework/errors'
import { colors, emitSuccess, isJsonMode } from '../framework/output'
import { notifyDaemonReload } from '../daemon/controller'

export function registerSettingsCommands(cli: CAC): void {
  cli
    .command(
      'settings <group> <action> [...kvs]',
      'Settings management (kiro show/set, auto-start show/on/off)'
    )
    .action(async (group: string, action: string, kvs: string[] = []) => {
      const service = await ensureServiceInitialized()
      if (group === 'kiro' && action === 'show') {
        const settings = await service.getKiroSettings()
        emitSuccess(settings, () => {
          if (isJsonMode()) return
          for (const [k, v] of Object.entries(settings)) {
            process.stdout.write(`  ${k.padEnd(20)} ${formatValue(v)}\n`)
          }
        })
        return
      }
      if (group === 'kiro' && action === 'set') {
        if (kvs.length === 0) {
          throw new CliError('Provide at least one key=value pair.', {
            code: ExitCode.UsageError,
            errorCode: 'MISSING_KV'
          })
        }
        const updates: Record<string, any> = {}
        for (const kv of kvs) {
          const eq = kv.indexOf('=')
          if (eq === -1) {
            throw new CliError(`Invalid key=value: ${kv}`, {
              code: ExitCode.UsageError,
              errorCode: 'INVALID_KV'
            })
          }
          const key = kv.slice(0, eq).trim()
          const raw = kv.slice(eq + 1)
          updates[key] = parseValue(raw)
        }
        await service.updateKiroSettings(updates)
        await notifyDaemonReload().catch(() => false)
        emitSuccess(updates, () =>
          process.stdout.write(`${colors.green('updated')} ${Object.keys(updates).join(', ')}\n`)
        )
        return
      }
      if (group === 'auto-start' && action === 'show') {
        const enabled = await service.getAutoStart()
        emitSuccess({ autoStart: enabled }, () =>
          process.stdout.write(`${enabled ? colors.green('on') : colors.gray('off')}\n`)
        )
        return
      }
      if (group === 'auto-start' && (action === 'on' || action === 'off')) {
        const enabled = action === 'on'
        await service.setAutoStart(enabled)
        await notifyDaemonReload().catch(() => false)
        emitSuccess({ autoStart: enabled }, () =>
          process.stdout.write(`${colors.green('autoStart')} ${enabled ? 'on' : 'off'}\n`)
        )
        return
      }
      throw new CliError(`Unknown settings command: ${group} ${action}`, {
        code: ExitCode.UsageError,
        errorCode: 'UNKNOWN_ACTION'
      })
    })
}

function parseValue(raw: string): unknown {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  return raw
}

function formatValue(v: unknown): string {
  if (v === undefined || v === null) return colors.dim('(empty)')
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}
