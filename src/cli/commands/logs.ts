import type { CAC } from 'cac'
import { ensureServiceInitialized } from '../bootstrap'
import { CliError, ExitCode } from '../framework/errors'
import { colors, emitSuccess, isJsonMode, printTable } from '../framework/output'
import { notifyDaemonReload } from '../daemon/controller'

const LOG_ACTIONS = ['list', 'export', 'clear'] as const
type LogAction = (typeof LOG_ACTIONS)[number]

export function registerLogsCommands(cli: CAC): void {
  cli
    .command('logs <action> [format]', `Log management (${LOG_ACTIONS.join('|')})`)
    .option('--category <cat>', 'Filter by category')
    .option('--request-id <id>', 'Filter by request id')
    .option('--level <level>', 'Filter by level')
    .option('--limit <n>', 'Max entries to return')
    .action(
      async (
        action: string,
        format: string | undefined,
        options: { category?: string; requestId?: string; level?: string; limit?: string }
      ) => {
        if (!LOG_ACTIONS.includes(action as LogAction)) {
          throw new CliError(
            `Unknown logs action: ${action}. Expected one of ${LOG_ACTIONS.join(', ')}.`,
            { code: ExitCode.UsageError, errorCode: 'UNKNOWN_ACTION' }
          )
        }
        const service = await ensureServiceInitialized()
        switch (action as LogAction) {
          case 'list':
            return runList(service, options)
          case 'export':
            return runExport(service, format)
          case 'clear':
            return runClear(service)
        }
      }
    )
}

async function runList(
  service: Awaited<ReturnType<typeof ensureServiceInitialized>>,
  options: { category?: string; requestId?: string; level?: string; limit?: string }
): Promise<void> {
  const logs = await service.getLogs({
    category: options.category as any,
    requestId: options.requestId,
    level: options.level,
    limit: options.limit ? Number(options.limit) : undefined
  })
  emitSuccess(logs, () => {
    if (isJsonMode()) return
    if (logs.length === 0) {
      process.stdout.write(`${colors.dim('(no logs)')}\n`)
      return
    }
    printTable(logs.slice(-50), [
      { header: 'TIME', get: (l: any) => new Date(l.timestamp).toISOString().slice(11, 19) },
      { header: 'LEVEL', get: (l: any) => levelColor(l.level ?? 'info') },
      { header: 'CAT', get: (l: any) => l.category ?? '' },
      { header: 'MESSAGE', get: (l: any) => truncate(l.message ?? '', 60) }
    ])
    if (logs.length > 50) {
      process.stdout.write(
        `${colors.dim(`... ${logs.length - 50} more entries (use --json for full output)`)}\n`
      )
    }
  })
}

async function runExport(
  service: Awaited<ReturnType<typeof ensureServiceInitialized>>,
  format?: string
): Promise<void> {
  const fmt = format === 'ndjson' ? 'ndjson' : 'json'
  const output = await service.exportLogs(fmt)
  process.stdout.write(output)
  if (!output.endsWith('\n')) process.stdout.write('\n')
}

async function runClear(
  service: Awaited<ReturnType<typeof ensureServiceInitialized>>
): Promise<void> {
  await service.clearLogs()
  await notifyDaemonReload().catch(() => false)
  emitSuccess({ cleared: true }, () => process.stdout.write(`${colors.green('logs cleared')}\n`))
}

function levelColor(level: string): string {
  if (level === 'error') return colors.red(level)
  if (level === 'warn') return colors.yellow(level)
  return level
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}
