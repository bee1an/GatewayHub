import type { CAC } from 'cac'
import { readFile } from 'fs/promises'
import { ensureServiceInitialized } from '../bootstrap'
import { daemonStatus, notifyDaemonReload } from '../daemon/controller'
import { CliError, ExitCode } from '../framework/errors'
import { colors, emitSuccess, isJsonMode, printTable } from '../framework/output'
import { setCliLoginSink } from '../../main/gateway/events/cliLoginEvents'

const QODER_ACTIONS = [
  'list',
  'login-cli',
  'import-cli',
  'import-token',
  'import-json',
  'test',
  'info',
  'refresh-models',
  'enable',
  'disable',
  'remove',
  'reset',
  'set-status',
  'chat'
] as const

type QoderAction = (typeof QODER_ACTIONS)[number]
type Service = Awaited<ReturnType<typeof ensureServiceInitialized>>

export function registerQoderCommands(cli: CAC): void {
  cli
    .command('qoder <action> [...args]', `Qoder provider utilities (${QODER_ACTIONS.join('|')})`)
    .option('--reason <text>', 'Reason for set-status')
    .option('--label <text>', 'Label for import-cli')
    .option('--qoder-cli-path <path>', 'qodercli binary path for import-cli')
    .option('--model <model>', 'Qoder model for chat smoke test', { default: 'auto' })
    .option('--prompt <text>', 'Prompt for chat smoke test', { default: 'Reply with OK only.' })
    .option('--max-tokens <n>', 'Max tokens for chat smoke test', { default: 64 })
    .action(async (action: string, args: string[] = [], options: QoderOptions) => {
      if (!QODER_ACTIONS.includes(action as QoderAction)) {
        throw new CliError(
          `Unknown Qoder action: ${action}. Expected one of ${QODER_ACTIONS.join(', ')}.`,
          { code: ExitCode.UsageError, errorCode: 'UNKNOWN_ACTION' }
        )
      }
      const service = await ensureServiceInitialized()
      switch (action as QoderAction) {
        case 'list':
          return runList(service)
        case 'login-cli':
          return runLoginCli(service, options)
        case 'import-cli':
          return runImportCli(service, options)
        case 'import-token':
          return runImportToken(service, args[0])
        case 'import-json':
          return runImportJson(service, args[0])
        case 'test':
          return runTest(service, requireArg(args, 0, 'account id'))
        case 'info':
          return runInfo(service, requireArg(args, 0, 'account id'))
        case 'refresh-models':
          return runRefreshModels(service, requireArg(args, 0, 'account id'))
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
        case 'chat':
          return runChat(service, {
            model: String(options.model || 'auto'),
            prompt: String(args[0] || options.prompt || 'Reply with OK only.'),
            maxTokens: Number(options.maxTokens ?? 64)
          })
      }
    })
}

interface QoderOptions {
  reason?: string
  label?: string
  qoderCliPath?: string
  model?: string
  prompt?: string
  maxTokens?: number | string
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

async function runList(service: Service): Promise<void> {
  const status = await service.getStatus()
  const provider = status.providers.find((item) => item.providerType === 'qoder') as any
  const accounts: any[] = provider?.accounts ?? []
  emitSuccess(accounts, () => {
    if (isJsonMode()) return
    if (!accounts.length) {
      process.stdout.write(`${colors.dim('(no Qoder accounts)')}\n`)
      return
    }
    printTable(accounts, [
      { header: 'ID', get: (a) => a.id },
      { header: 'LABEL', get: (a) => a.email ?? a.label ?? '' },
      { header: 'ENABLED', get: (a) => (a.enabled ? colors.green('yes') : colors.gray('no')) },
      { header: 'STATUS', get: (a) => statusColor(a.status ?? 'unknown') },
      { header: 'MODELS', get: (a) => String(a.models?.length ?? 0), align: 'right' }
    ])
  })
}

async function runImportToken(service: Service, text: string | undefined): Promise<void> {
  const value = text ?? (await readStdin())
  if (!value) {
    throw new CliError('Provide Qoder Personal Access Token as argument or via stdin.', {
      code: ExitCode.UsageError,
      errorCode: 'MISSING_TOKEN'
    })
  }
  const result = await service.addQoderPersonalAccessToken(value.trim())
  await notifyDaemonReload().catch(() => false)
  emitSuccess(result, () => process.stdout.write(`${colors.green('imported')} Qoder account\n`))
}

async function runImportCli(service: Service, options: QoderOptions): Promise<void> {
  const result = await service.addQoderCliLogin({
    label: options.label,
    qoderCliPath: options.qoderCliPath
  })
  await notifyDaemonReload().catch(() => false)
  emitSuccess(result, () =>
    process.stdout.write(`${colors.green('imported')} current qodercli auth\n`)
  )
}

async function runLoginCli(service: Service, options: QoderOptions): Promise<void> {
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

  const sigintHandler = async (): Promise<void> => {
    process.stderr.write('\nCancelling qodercli login...\n')
    try {
      await service.cancelQoderCliLogin()
    } catch {
      /* ignore */
    }
  }
  process.on('SIGINT', sigintHandler)

  try {
    const detect = await service.detectQoderCli(options.qoderCliPath)
    if (!detect.found) {
      throw new CliError(
        `qodercli not found${options.qoderCliPath ? ` at ${options.qoderCliPath}` : ' on PATH'}. Install qodercli or pass --qoder-cli-path.`,
        { code: ExitCode.GeneralError, errorCode: 'QODER_CLI_NOT_FOUND' }
      )
    }
    await service.loginWithQoderCli({ cliPath: detect.path, label: options.label })
    const exit = await completion
    await notifyDaemonReload().catch(() => false)
    if (exit.error) {
      throw new CliError(exit.error, {
        code: ExitCode.GeneralError,
        errorCode: 'QODER_CLI_FAILED'
      })
    }
    emitSuccess({ imported: exit.imported ?? false, code: exit.code }, () => {
      process.stdout.write(
        exit.imported
          ? `${colors.green('imported')} via qodercli login\n`
          : `${colors.yellow('finished')} qodercli exit=${exit.code}\n`
      )
    })
  } finally {
    process.removeListener('SIGINT', sigintHandler)
  }
}

async function runImportJson(service: Service, source: string | undefined): Promise<void> {
  const text = !source || source === '-' ? await readStdin() : await readFile(source, 'utf8')
  if (!text) {
    throw new CliError('No Qoder JSON content provided.', {
      code: ExitCode.UsageError,
      errorCode: 'MISSING_JSON'
    })
  }
  const result = await service.importQoderAuthJson(text)
  await notifyDaemonReload().catch(() => false)
  emitSuccess(result, () =>
    process.stdout.write(
      `${colors.green('imported')} added=${result.added}, skipped=${result.skipped}, errors=${result.errors.length}\n`
    )
  )
}

async function runTest(service: Service, id: string): Promise<void> {
  const result = await service.testQoderAccount(id)
  await notifyDaemonReload().catch(() => false)
  emitSuccess(result, () => {
    process.stdout.write(
      `${result.ok ? colors.green('ok') : colors.red('fail')} ${result.accountId}: ${result.message}\n`
    )
  })
}

async function runInfo(service: Service, id: string): Promise<void> {
  emitSuccess(await service.getQoderAccountInfo(id))
}

async function runRefreshModels(service: Service, id: string): Promise<void> {
  const result = await service.refreshQoderAccountModels(id)
  await notifyDaemonReload().catch(() => false)
  emitSuccess(result, () =>
    process.stdout.write(`${colors.green('models')} ${result.models.length}\n`)
  )
}

async function runToggle(service: Service, id: string, enabled: boolean): Promise<void> {
  await service.toggleQoderAccount(id, enabled)
  await notifyDaemonReload().catch(() => false)
  emitSuccess({ id, enabled }, () =>
    process.stdout.write(`${enabled ? colors.green('enabled') : colors.yellow('disabled')} ${id}\n`)
  )
}

async function runRemove(service: Service, id: string): Promise<void> {
  await service.removeQoderAccount(id)
  await notifyDaemonReload().catch(() => false)
  emitSuccess({ id, removed: true }, () =>
    process.stdout.write(`${colors.green('removed')} ${id}\n`)
  )
}

async function runReset(service: Service, id: string): Promise<void> {
  await service.resetQoderAccount(id)
  await notifyDaemonReload().catch(() => false)
  emitSuccess({ id, reset: true }, () => process.stdout.write(`${colors.green('reset')} ${id}\n`))
}

async function runSetStatus(
  service: Service,
  id: string,
  status: string,
  reason?: string
): Promise<void> {
  await service.setQoderAccountStatus(id, status as any, reason)
  await notifyDaemonReload().catch(() => false)
  emitSuccess({ id, status, reason }, () =>
    process.stdout.write(`${colors.green('status set')} ${id} → ${status}\n`)
  )
}

async function runChat(
  service: Service,
  options: { model: string; prompt: string; maxTokens: number }
): Promise<void> {
  const target = await resolveGatewayTarget(service)
  try {
    const response = await fetch(`${target.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${target.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: `qoder/${options.model}`,
        stream: false,
        max_tokens: Number.isFinite(options.maxTokens) ? options.maxTokens : 64,
        messages: [{ role: 'user', content: options.prompt }]
      }),
      signal: AbortSignal.timeout(240_000)
    })
    const payload = parseJsonText(await response.text()) as any
    if (!response.ok || payload?.error) {
      throw new CliError(
        `Qoder chat failed: HTTP ${response.status} ${JSON.stringify(payload).slice(0, 800)}`,
        { code: ExitCode.GeneralError, errorCode: 'QODER_CHAT_FAILED' }
      )
    }
    emitSuccess(payload, () => {
      const text = payload?.choices?.[0]?.message?.content ?? ''
      process.stdout.write(`${text || JSON.stringify(payload, null, 2)}\n`)
    })
  } finally {
    if (target.startedInProcess) {
      await service.stop().catch(() => undefined)
    }
  }
}

async function resolveGatewayTarget(
  service: Service
): Promise<{ url: string; apiKey: string; startedInProcess: boolean }> {
  const daemon: Awaited<ReturnType<typeof daemonStatus>> = await daemonStatus().catch(() => ({
    running: false
  }))
  if (daemon.running && daemon.host && daemon.port) {
    const daemonKey =
      daemon.serviceStatus?.server?.apiKeys?.[0]?.key ??
      (await service.getStatus()).server.apiKeys[0]?.key
    if (!daemonKey) {
      throw new CliError('No GatewayHub API key configured.', {
        code: ExitCode.GeneralError,
        errorCode: 'NO_API_KEY'
      })
    }
    return {
      url: `http://${daemon.host}:${daemon.port}`,
      apiKey: daemonKey,
      startedInProcess: false
    }
  }

  let status = await service.getStatus()
  let startedInProcess = false
  const existingApiKey = status.server.apiKeys[0]?.key
  if (status.server.url && existingApiKey && (await probeGatewayHealth(status.server.url))) {
    return { url: status.server.url, apiKey: existingApiKey, startedInProcess: false }
  }
  if (!status.server.running) {
    status = await service.start()
    startedInProcess = true
  }
  const apiKey = status.server.apiKeys[0]?.key
  if (!apiKey) {
    throw new CliError('No GatewayHub API key configured.', {
      code: ExitCode.GeneralError,
      errorCode: 'NO_API_KEY'
    })
  }
  return { url: status.server.url, apiKey, startedInProcess }
}

async function probeGatewayHealth(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/health`, {
      signal: AbortSignal.timeout(2_000)
    })
    return response.ok
  } catch {
    return false
  }
}

function parseJsonText(text: string): unknown {
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

function statusColor(status: string): string {
  if (status === 'available' || status === 'ready') return colors.green(status)
  if (status === 'auth_failed' || status === 'quota_exceeded' || status === 'error') {
    return colors.red(status)
  }
  if (status === 'manual_disabled' || status === 'disabled') return colors.gray(status)
  return colors.yellow(status)
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString('utf8').trim()
}
