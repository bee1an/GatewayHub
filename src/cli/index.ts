import { configureCliRuntime } from './bootstrap'
import { createApp, syncGlobalOptions } from './framework/app'
import { ExitCode, isCliError } from './framework/errors'
import { emitError, isJsonMode, setGlobalOptions } from './framework/output'
import { LockBusyError } from '../main/gateway/core/lockfile'
import { registerGatewayCommands } from './commands/gateway'
import { registerAccountCommands } from './commands/account'
import { registerApikeyCommands } from './commands/apikey'
import { registerMappingCommands } from './commands/mapping'
import { registerModelCommands } from './commands/model'
import { registerProviderCommands } from './commands/provider'
import { registerSettingsCommands } from './commands/settings'
import { registerConfigCommands } from './commands/config'
import { registerLogsCommands } from './commands/logs'
import { registerShellCommands } from './commands/shell'
import { registerTraeCommands } from './commands/trae'
import { registerOpenRouterCommands } from './commands/openrouter'
import { registerNvidiaCommands } from './commands/nvidia'

async function main(): Promise<void> {
  configureCliRuntime()

  const cli = createApp()
  registerGatewayCommands(cli)
  registerAccountCommands(cli)
  registerApikeyCommands(cli)
  registerMappingCommands(cli)
  registerModelCommands(cli)
  registerProviderCommands(cli)
  registerSettingsCommands(cli)
  registerTraeCommands(cli)
  registerOpenRouterCommands(cli)
  registerNvidiaCommands(cli)
  registerConfigCommands(cli)
  registerLogsCommands(cli)
  registerShellCommands(cli)

  // Single parse with auto-run; cac handles --help/--version internally.
  cli.parse(process.argv, { run: false })
  syncGlobalOptions(cli.options as Record<string, unknown>)

  if (cli.matchedCommandName) {
    await cli.runMatchedCommand()
  } else if (!cli.options.help && !cli.options.version) {
    cli.outputHelp()
  }
}

main().catch((err) => {
  const code = handleError(err)
  process.exit(code)
})

function handleError(err: unknown): number {
  setGlobalOptions({ json: isJsonMode() })

  if (isCliError(err)) {
    emitError(err.message, err.errorCode)
    return err.code
  }
  if (err instanceof LockBusyError) {
    emitError(err.message, 'LOCK_BUSY')
    return ExitCode.LockBusy
  }
  if (err instanceof Error) {
    emitError(err.message, 'INTERNAL_ERROR')
    return ExitCode.GeneralError
  }
  emitError(String(err), 'INTERNAL_ERROR')
  return ExitCode.GeneralError
}
