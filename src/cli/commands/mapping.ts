import type { CAC } from 'cac'
import { ensureServiceInitialized } from '../bootstrap'
import { CliError, ExitCode } from '../framework/errors'
import { colors, emitSuccess, isJsonMode, printTable } from '../framework/output'
import { notifyDaemonReload } from '../daemon/controller'

const MAPPING_ACTIONS = ['list', 'set', 'remove'] as const
type MappingAction = (typeof MAPPING_ACTIONS)[number]

export function registerMappingCommands(cli: CAC): void {
  cli
    .command('mapping <action> [alias]', `Model mapping management (${MAPPING_ACTIONS.join('|')})`)
    .option('--provider <p>', 'Provider for set')
    .option('--model <m>', 'Real model id for set')
    .option('--note <text>', 'Optional note')
    .option('--enabled <bool>', 'Enable/disable mapping (default true)')
    .action(
      async (
        action: string,
        alias: string | undefined,
        options: {
          provider?: string
          model?: string
          note?: string
          enabled?: string | boolean
        }
      ) => {
        if (!MAPPING_ACTIONS.includes(action as MappingAction)) {
          throw new CliError(
            `Unknown mapping action: ${action}. Expected one of ${MAPPING_ACTIONS.join(', ')}.`,
            { code: ExitCode.UsageError, errorCode: 'UNKNOWN_ACTION' }
          )
        }
        const service = await ensureServiceInitialized()
        switch (action as MappingAction) {
          case 'list':
            return runList(service)
          case 'set':
            return runSet(service, requireAlias(alias), options)
          case 'remove':
            return runRemove(service, requireAlias(alias))
        }
      }
    )
}

function requireAlias(alias?: string): string {
  if (!alias) {
    throw new CliError('Missing argument: <alias>', {
      code: ExitCode.UsageError,
      errorCode: 'MISSING_ARG'
    })
  }
  return alias
}

async function runList(
  service: Awaited<ReturnType<typeof ensureServiceInitialized>>
): Promise<void> {
  const mappings = await service.getModelMappings()
  emitSuccess(mappings, () => {
    if (isJsonMode()) return
    if (mappings.length === 0) {
      process.stdout.write(`${colors.dim('(no mappings)')}\n`)
      return
    }
    printTable(mappings, [
      { header: 'ALIAS', get: (m) => m.alias },
      { header: 'PROVIDER', get: (m) => m.provider },
      { header: 'MODEL', get: (m) => m.model },
      {
        header: 'ENABLED',
        get: (m) => (m.enabled !== false ? colors.green('yes') : colors.gray('no'))
      },
      { header: 'NOTE', get: (m) => m.note ?? '' }
    ])
  })
}

async function runSet(
  service: Awaited<ReturnType<typeof ensureServiceInitialized>>,
  alias: string,
  options: { provider?: string; model?: string; note?: string; enabled?: string | boolean }
): Promise<void> {
  if (!options.provider || !options.model) {
    throw new CliError('--provider and --model are required for set.', {
      code: ExitCode.UsageError,
      errorCode: 'MISSING_OPTION'
    })
  }
  const current = await service.getModelMappings()
  const enabled =
    options.enabled === undefined
      ? true
      : options.enabled === true || options.enabled === 'true' || options.enabled === '1'
  const next = current.filter((m) => m.alias !== alias)
  next.push({
    alias,
    provider: options.provider,
    model: options.model,
    enabled,
    ...(options.note ? { note: options.note } : {})
  })
  await service.updateModelMappings(next)
  await notifyDaemonReload().catch(() => false)
  emitSuccess({ alias, provider: options.provider, model: options.model }, () =>
    process.stdout.write(`${colors.green('set')} ${alias} → ${options.provider}/${options.model}\n`)
  )
}

async function runRemove(
  service: Awaited<ReturnType<typeof ensureServiceInitialized>>,
  alias: string
): Promise<void> {
  const current = await service.getModelMappings()
  if (!current.some((m) => m.alias === alias)) {
    throw new CliError(`Mapping not found: ${alias}`, {
      code: ExitCode.GeneralError,
      errorCode: 'MAPPING_NOT_FOUND'
    })
  }
  await service.updateModelMappings(current.filter((m) => m.alias !== alias))
  await notifyDaemonReload().catch(() => false)
  emitSuccess({ alias, removed: true }, () =>
    process.stdout.write(`${colors.green('removed')} ${alias}\n`)
  )
}
