import type { CAC } from 'cac'
import { readFile } from 'fs/promises'
import { ensureServiceInitialized } from '../bootstrap'
import { CliError, ExitCode } from '../framework/errors'
import { colors, emitSuccess, isJsonMode, printTable } from '../framework/output'
import { notifyDaemonReload } from '../daemon/controller'
import { setCliLoginSink } from '../../main/gateway/events/cliLoginEvents'

const ACCOUNT_ACTIONS = [
  'list',
  'info',
  'test',
  'enable',
  'disable',
  'remove',
  'reset',
  'set-status',
  'scan',
  'auto-discover'
] as const
type AccountAction = (typeof ACCOUNT_ACTIONS)[number]

const IMPORT_KINDS = ['token', 'json', 'scanned', 'kiro-cli'] as const
type ImportKind = (typeof IMPORT_KINDS)[number]

export function registerAccountCommands(cli: CAC): void {
  cli
    .command('account <action> [...args]', `Account management (${ACCOUNT_ACTIONS.join('|')})`)
    .option('--reason <text>', 'Reason for set-status')
    .action(async (action: string, args: string[] = [], options: { reason?: string }) => {
      if (!ACCOUNT_ACTIONS.includes(action as AccountAction)) {
        throw new CliError(
          `Unknown account action: ${action}. Expected one of ${ACCOUNT_ACTIONS.join(', ')}.`,
          { code: ExitCode.UsageError, errorCode: 'UNKNOWN_ACTION' }
        )
      }
      const service = await ensureServiceInitialized()
      switch (action as AccountAction) {
        case 'list':
          return runList(service)
        case 'info':
          return runInfo(service, requireArg(args, 0, 'account id'))
        case 'test':
          return runTest(service, requireArg(args, 0, 'account id'))
        case 'enable':
          return runToggle(service, requireArg(args, 0, 'account id'), true)
        case 'disable':
          return runToggle(service, requireArg(args, 0, 'account id'), false)
        case 'remove':
          return runRemove(service, requireArg(args, 0, 'account id'))
        case 'reset':
          return runReset(service, requireArg(args, 0, 'account id'))
        case 'set-status':
          return runSetStatus(
            service,
            requireArg(args, 0, 'account id'),
            requireArg(args, 1, 'status'),
            options.reason
          )
        case 'scan':
          return runScan(service)
        case 'auto-discover':
          return runAutoDiscover(service)
      }
    })

  cli
    .command('account-import <kind> [...args]', `Import accounts (${IMPORT_KINDS.join('|')})`)
    .option('--type <type>', 'Token type (refresh|access) for `token` kind', { default: 'refresh' })
    .option('--cli-path <path>', 'kiro-cli binary path')
    .action(
      async (kind: string, args: string[] = [], options: { type?: string; cliPath?: string }) => {
        if (!IMPORT_KINDS.includes(kind as ImportKind)) {
          throw new CliError(
            `Unknown import kind: ${kind}. Expected one of ${IMPORT_KINDS.join(', ')}.`,
            { code: ExitCode.UsageError, errorCode: 'UNKNOWN_IMPORT_KIND' }
          )
        }
        const service = await ensureServiceInitialized()
        switch (kind as ImportKind) {
          case 'token':
            return runImportToken(service, args[0], options.type ?? 'refresh')
          case 'json':
            return runImportJson(service, args[0])
          case 'scanned':
            return runImportScanned(service, args)
          case 'kiro-cli':
            return runImportKiroCli(service, options.cliPath)
        }
      }
    )
}

function requireArg(args: string[], idx: number, name: string): string {
  if (!args[idx]) {
    throw new CliError(`Missing argument: <${name}>`, {
      code: ExitCode.UsageError,
      errorCode: 'MISSING_ARG'
    })
  }
  return args[idx]
}

async function runList(
  service: Awaited<ReturnType<typeof ensureServiceInitialized>>
): Promise<void> {
  const status = await service.getStatus()
  const kiro = status.providers.find((p) => p.providerType === 'kiro') as any
  const accounts: any[] = kiro?.accounts ?? []
  emitSuccess(accounts, () => {
    if (isJsonMode()) return
    if (accounts.length === 0) {
      process.stdout.write(`${colors.dim('(no accounts)')}\n`)
      return
    }
    printTable(accounts, [
      { header: 'ID', get: (a) => a.id },
      { header: 'EMAIL', get: (a) => a.email ?? a.label ?? '' },
      { header: 'ENABLED', get: (a) => (a.enabled ? colors.green('yes') : colors.gray('no')) },
      { header: 'STATUS', get: (a) => statusColor(a.status ?? 'unknown') },
      { header: 'FAILS', get: (a) => String(a.failures ?? 0), align: 'right' }
    ])
  })
}

async function runInfo(
  service: Awaited<ReturnType<typeof ensureServiceInitialized>>,
  id: string
): Promise<void> {
  const info = await service.getAccountInfo(id)
  emitSuccess(info)
}

async function runTest(
  service: Awaited<ReturnType<typeof ensureServiceInitialized>>,
  id: string
): Promise<void> {
  const result = await service.testKiroAccount(id)
  await notifyDaemonReload().catch(() => false)
  emitSuccess(result, () => {
    process.stdout.write(
      `${result.ok ? colors.green('ok') : colors.red('fail')} ${result.accountId}: ${result.message}\n`
    )
  })
}

async function runToggle(
  service: Awaited<ReturnType<typeof ensureServiceInitialized>>,
  id: string,
  enabled: boolean
): Promise<void> {
  await service.toggleKiroAccount(id, enabled)
  await notifyDaemonReload().catch(() => false)
  emitSuccess({ id, enabled }, () => {
    process.stdout.write(`${enabled ? colors.green('enabled') : colors.yellow('disabled')} ${id}\n`)
  })
}

async function runRemove(
  service: Awaited<ReturnType<typeof ensureServiceInitialized>>,
  id: string
): Promise<void> {
  await service.removeKiroAccount(id)
  await notifyDaemonReload().catch(() => false)
  emitSuccess({ id, removed: true }, () => {
    process.stdout.write(`${colors.green('removed')} ${id}\n`)
  })
}

async function runReset(
  service: Awaited<ReturnType<typeof ensureServiceInitialized>>,
  id: string
): Promise<void> {
  await service.resetKiroAccount(id)
  await notifyDaemonReload().catch(() => false)
  emitSuccess({ id, reset: true }, () => {
    process.stdout.write(`${colors.green('reset')} ${id}\n`)
  })
}

async function runSetStatus(
  service: Awaited<ReturnType<typeof ensureServiceInitialized>>,
  id: string,
  status: string,
  reason?: string
): Promise<void> {
  await service.setKiroAccountStatus(id, status as any, reason)
  await notifyDaemonReload().catch(() => false)
  emitSuccess({ id, status, reason }, () => {
    process.stdout.write(`${colors.green('status set')} ${id} → ${status}\n`)
  })
}

async function runScan(
  service: Awaited<ReturnType<typeof ensureServiceInitialized>>
): Promise<void> {
  const { candidates } = await service.scanKiroAccounts()
  emitSuccess(candidates, () => {
    if (isJsonMode()) return
    if (candidates.length === 0) {
      process.stdout.write(`${colors.dim('(no candidates)')}\n`)
      return
    }
    printTable(candidates, [
      { header: 'ID', get: (c: any) => c.id },
      { header: 'EMAIL', get: (c: any) => c.email ?? c.label ?? '' },
      { header: 'SOURCE', get: (c: any) => c.sourceType ?? '' },
      { header: 'EXISTING', get: (c: any) => (c.existing ? colors.gray('yes') : 'no') }
    ])
  })
}

async function runAutoDiscover(
  service: Awaited<ReturnType<typeof ensureServiceInitialized>>
): Promise<void> {
  const result = await service.autoDiscoverKiroAccounts()
  await notifyDaemonReload().catch(() => false)
  emitSuccess(result, () => {
    process.stdout.write(
      `${colors.green('discovered')} added=${(result as any).added ?? 0}, skipped=${(result as any).skipped ?? 0}\n`
    )
  })
}

async function runImportToken(
  service: Awaited<ReturnType<typeof ensureServiceInitialized>>,
  text: string | undefined,
  type: string
): Promise<void> {
  const value = text ?? (await readStdin())
  if (!value) {
    throw new CliError('Provide token text as argument or via stdin.', {
      code: ExitCode.UsageError,
      errorCode: 'MISSING_TOKEN'
    })
  }
  const result =
    type === 'access'
      ? await service.addKiroAccessToken(value.trim())
      : await service.addKiroRefreshToken(value.trim())
  await notifyDaemonReload().catch(() => false)
  emitSuccess(result, () => process.stdout.write(`${colors.green('imported')}\n`))
}

async function runImportJson(
  service: Awaited<ReturnType<typeof ensureServiceInitialized>>,
  source: string | undefined
): Promise<void> {
  let text: string
  if (!source || source === '-') {
    text = await readStdin()
  } else {
    text = await readFile(source, 'utf8')
  }
  if (!text) {
    throw new CliError('No JSON content provided.', {
      code: ExitCode.UsageError,
      errorCode: 'MISSING_JSON'
    })
  }
  const result = await service.importKiroJson(text)
  await notifyDaemonReload().catch(() => false)
  emitSuccess(result, () => {
    process.stdout.write(
      `${colors.green('imported')} added=${result.added}, skipped=${result.skipped}, errors=${result.errors.length}\n`
    )
  })
}

async function runImportScanned(
  service: Awaited<ReturnType<typeof ensureServiceInitialized>>,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) {
    throw new CliError('Provide at least one account id.', {
      code: ExitCode.UsageError,
      errorCode: 'MISSING_IDS'
    })
  }
  const result = await service.importScannedAccounts(ids)
  await notifyDaemonReload().catch(() => false)
  emitSuccess(result, () => {
    process.stdout.write(`${colors.green('imported')} ${result.added.length} account(s)\n`)
  })
}

async function runImportKiroCli(
  service: Awaited<ReturnType<typeof ensureServiceInitialized>>,
  cliPath?: string
): Promise<void> {
  // Set up sink that streams CLI output to our stdout/stderr and resolves on exit.
  const completion = new Promise<{ code: number | null; imported?: boolean; error?: string }>(
    (resolve) => {
      setCliLoginSink({
        emit: (event) => {
          if (event.type === 'stdout') process.stdout.write(event.text)
          else if (event.type === 'stderr') process.stderr.write(event.text)
          else if (event.type === 'error') process.stderr.write(`${event.message}\n`)
          else if (event.type === 'exit') resolve(event)
        }
      })
    }
  )

  // Cancel on Ctrl-C
  const sigintHandler = async (): Promise<void> => {
    process.stderr.write('\nCancelling kiro-cli login...\n')
    try {
      await service.cancelKiroCliLogin()
    } catch {
      /* ignore */
    }
  }
  process.on('SIGINT', sigintHandler)

  try {
    const detect = await service.detectKiroCli(cliPath)
    if (!detect.found) {
      throw new CliError(
        `kiro-cli not found${cliPath ? ` at ${cliPath}` : ' on PATH'}. Install kiro-cli or pass --cli-path.`,
        { code: ExitCode.GeneralError, errorCode: 'KIRO_CLI_NOT_FOUND' }
      )
    }
    await service.loginWithKiroCli({ cliPath: detect.path })
    const exit = await completion
    await notifyDaemonReload().catch(() => false)
    if (exit.error) {
      throw new CliError(exit.error, { code: ExitCode.GeneralError, errorCode: 'KIRO_CLI_FAILED' })
    }
    emitSuccess({ imported: exit.imported ?? false, code: exit.code }, () => {
      process.stdout.write(
        exit.imported
          ? `${colors.green('imported')} via kiro-cli\n`
          : `${colors.yellow('finished')} kiro-cli exit=${exit.code}\n`
      )
    })
  } finally {
    process.removeListener('SIGINT', sigintHandler)
  }
}

function statusColor(status: string): string {
  if (status === 'ready' || status === 'active') return colors.green(status)
  if (status === 'error' || status === 'rate_limited') return colors.red(status)
  if (status === 'disabled' || status === 'manual_disabled') return colors.gray(status)
  return colors.yellow(status)
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}
