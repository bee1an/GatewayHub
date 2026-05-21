import type { CAC } from 'cac'
import { ensureServiceInitialized } from '../bootstrap'
import { CliError, ExitCode } from '../framework/errors'
import { colors, emitSuccess, isJsonMode, printTable } from '../framework/output'

export function registerModelCommands(cli: CAC): void {
  cli.command('model <action>', 'Model listing (list)').action(async (action: string) => {
    if (action !== 'list') {
      throw new CliError(`Unknown model action: ${action}`, {
        code: ExitCode.UsageError,
        errorCode: 'UNKNOWN_ACTION'
      })
    }
    const service = await ensureServiceInitialized()
    const models = await service.listModels()
    emitSuccess(models, () => {
      if (isJsonMode()) return
      if (!models.length) {
        process.stdout.write(`${colors.dim('(no models)')}\n`)
        return
      }
      printTable(models, [
        { header: 'PROVIDER', get: (m: any) => m.provider ?? '' },
        { header: 'MODEL', get: (m: any) => m.id ?? m.model ?? '' },
        { header: 'NAME', get: (m: any) => m.name ?? m.id ?? '' }
      ])
    })
  })
}
