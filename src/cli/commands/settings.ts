import type { CAC } from 'cac'
import { ensureServiceInitialized } from '../bootstrap'
import { CliError, ExitCode } from '../framework/errors'
import { colors, emitSuccess, isJsonMode } from '../framework/output'
import { notifyDaemonReload } from '../daemon/controller'
import { DEFAULT_KIRO_SETTINGS } from '../../main/gateway/providers/kiro/constants'
import { DEFAULT_TRAE_SETTINGS } from '../../main/gateway/providers/trae/constants'
import { DEFAULT_OPENROUTER_SETTINGS } from '../../main/gateway/providers/openrouter/constants'
import { DEFAULT_NVIDIA_SETTINGS } from '../../main/gateway/providers/nvidia/constants'
import { DEFAULT_GPT_WEB_SETTINGS } from '../../main/gateway/providers/gptWeb/constants'
import { DEFAULT_GROK_WEB_SETTINGS } from '../../main/gateway/providers/grokWeb/constants'

const PROVIDER_SETTING_KEYS = {
  kiro: new Set(Object.keys(DEFAULT_KIRO_SETTINGS)),
  trae: new Set(Object.keys(DEFAULT_TRAE_SETTINGS)),
  openrouter: new Set(Object.keys(DEFAULT_OPENROUTER_SETTINGS)),
  nvidia: new Set(Object.keys(DEFAULT_NVIDIA_SETTINGS)),
  gptWeb: new Set(Object.keys(DEFAULT_GPT_WEB_SETTINGS)),
  grokWeb: new Set(Object.keys(DEFAULT_GROK_WEB_SETTINGS))
} as const

type ProviderSettingsGroup = keyof typeof PROVIDER_SETTING_KEYS

export function registerSettingsCommands(cli: CAC): void {
  cli
    .command(
      'settings <group> <action> [...kvs]',
      'Settings management (kiro|trae|openrouter|nvidia|gptWeb|grokWeb show/set, auto-start show/on/off)'
    )
    .action(async (group: string, action: string, kvs: string[] = []) => {
      const service = await ensureServiceInitialized()
      if (isProviderSettingsGroup(group) && action === 'show') {
        const settings = await getProviderSettings(service, group)
        emitSuccess(settings, () => {
          if (isJsonMode()) return
          for (const [k, v] of Object.entries(settings)) {
            process.stdout.write(`  ${k.padEnd(20)} ${formatValue(v)}\n`)
          }
        })
        return
      }
      if (isProviderSettingsGroup(group) && action === 'set') {
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
          if (!PROVIDER_SETTING_KEYS[group].has(key)) {
            throw new CliError(`Unknown ${group} setting: ${key}`, {
              code: ExitCode.UsageError,
              errorCode: 'UNKNOWN_SETTING'
            })
          }
          updates[key] = parseValue(raw)
        }
        await updateProviderSettings(service, group, updates)
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

type Service = Awaited<ReturnType<typeof ensureServiceInitialized>>

function isProviderSettingsGroup(group: string): group is ProviderSettingsGroup {
  return (
    group === 'kiro' ||
    group === 'trae' ||
    group === 'openrouter' ||
    group === 'nvidia' ||
    group === 'gptWeb' ||
    group === 'grokWeb'
  )
}

function getProviderSettings(service: Service, group: ProviderSettingsGroup): Promise<any> {
  if (group === 'trae') return service.getTraeSettings()
  if (group === 'openrouter') return service.getOpenRouterSettings()
  if (group === 'nvidia') return service.getNvidiaSettings()
  if (group === 'gptWeb') return service.getGptWebSettings()
  if (group === 'grokWeb') return service.getGrokWebSettings()
  return service.getKiroSettings()
}

function updateProviderSettings(
  service: Service,
  group: ProviderSettingsGroup,
  updates: Record<string, any>
): Promise<any> {
  if (group === 'trae') return service.updateTraeSettings(updates)
  if (group === 'openrouter') return service.updateOpenRouterSettings(updates)
  if (group === 'nvidia') return service.updateNvidiaSettings(updates)
  if (group === 'gptWeb') return service.updateGptWebSettings(updates)
  if (group === 'grokWeb') return service.updateGrokWebSettings(updates)
  return service.updateKiroSettings(updates)
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
