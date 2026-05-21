import type { CAC } from 'cac'
import { ensureServiceInitialized } from '../bootstrap'
import { CliError, ExitCode } from '../framework/errors'
import { colors, emitSuccess } from '../framework/output'
import { notifyDaemonReload } from '../daemon/controller'

const PROVIDER_ACTIONS = ['route', 'display-name'] as const
type ProviderAction = (typeof PROVIDER_ACTIONS)[number]

export function registerProviderCommands(cli: CAC): void {
  cli
    .command(
      'provider <action> <type> <value>',
      `Provider configuration (${PROVIDER_ACTIONS.join('|')})`
    )
    .action(async (action: string, type: string, value: string) => {
      if (!PROVIDER_ACTIONS.includes(action as ProviderAction)) {
        throw new CliError(
          `Unknown provider action: ${action}. Expected one of ${PROVIDER_ACTIONS.join(', ')}.`,
          { code: ExitCode.UsageError, errorCode: 'UNKNOWN_ACTION' }
        )
      }
      const service = await ensureServiceInitialized()
      if (action === 'route') {
        await service.updateProviderRouteName(type, value)
        await notifyDaemonReload().catch(() => false)
        emitSuccess({ type, routeName: value }, () =>
          process.stdout.write(`${colors.green('route updated')} ${type} → ${value}\n`)
        )
      } else {
        await service.updateProviderDisplayName(type, value)
        await notifyDaemonReload().catch(() => false)
        emitSuccess({ type, displayName: value }, () =>
          process.stdout.write(`${colors.green('display name updated')} ${type} → ${value}\n`)
        )
      }
    })
}
