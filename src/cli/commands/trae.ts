import type { CAC } from 'cac'
import { readFile } from 'fs/promises'
import { ensureServiceInitialized } from '../bootstrap'
import { daemonStatus, notifyDaemonReload } from '../daemon/controller'
import { CliError, ExitCode } from '../framework/errors'
import { colors, emitSuccess, isJsonMode, printTable } from '../framework/output'
import { DEFAULT_TRAE_MODEL } from '../../main/gateway/providers/trae/constants'

const TRAE_ACTIONS = [
  'list',
  'scan',
  'import-token',
  'import-json',
  'import-scanned',
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

type TraeAction = (typeof TRAE_ACTIONS)[number]

export function registerTraeCommands(cli: CAC): void {
  cli
    .command('trae <action> [...args]', `Trae provider utilities (${TRAE_ACTIONS.join('|')})`)
    .option('--type <type>', 'Token type for import-token (refresh|jwt)', { default: 'refresh' })
    .option('--reason <text>', 'Reason for set-status')
    .option('--model <model>', 'Model for chat smoke test', { default: DEFAULT_TRAE_MODEL })
    .option('--prompt <text>', 'Prompt for chat smoke test', { default: 'Reply with OK only.' })
    .option('--max-tokens <n>', 'Max tokens for chat smoke test', { default: 64 })
    .action(async (action: string, args: string[] = [], options: TraeOptions) => {
      if (!TRAE_ACTIONS.includes(action as TraeAction)) {
        throw new CliError(
          `Unknown Trae action: ${action}. Expected one of ${TRAE_ACTIONS.join(', ')}.`,
          { code: ExitCode.UsageError, errorCode: 'UNKNOWN_ACTION' }
        )
      }
      const service = await ensureServiceInitialized()
      switch (action as TraeAction) {
        case 'list':
          return runList(service)
        case 'scan':
          return runScan(service)
        case 'import-token':
          return runImportToken(service, args[0], options.type ?? 'refresh')
        case 'import-json':
          return runImportJson(service, args[0])
        case 'import-scanned':
          return runImportScanned(service, args)
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
            model: String(options.model || DEFAULT_TRAE_MODEL),
            prompt: String(args[0] || options.prompt || 'Reply with OK only.'),
            maxTokens: Number(options.maxTokens ?? 64)
          })
      }
    })
}

interface TraeOptions {
  type?: string
  reason?: string
  model?: string
  prompt?: string
  maxTokens?: number | string
}

type Service = Awaited<ReturnType<typeof ensureServiceInitialized>>

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
  const trae = status.providers.find((provider) => provider.providerType === 'trae') as any
  const accounts: any[] = trae?.accounts ?? []
  emitSuccess(accounts, () => {
    if (isJsonMode()) return
    if (accounts.length === 0) {
      process.stdout.write(`${colors.dim('(no Trae accounts)')}\n`)
      return
    }
    printTable(accounts, [
      { header: 'ID', get: (a) => a.id },
      { header: 'EMAIL', get: (a) => a.email ?? a.label ?? '' },
      { header: 'ENABLED', get: (a) => (a.enabled ? colors.green('yes') : colors.gray('no')) },
      { header: 'STATUS', get: (a) => statusColor(a.status ?? 'unknown') },
      { header: 'MODELS', get: (a) => String(a.models?.length ?? 0), align: 'right' }
    ])
  })
}

async function runScan(service: Service): Promise<void> {
  const { candidates } = await service.scanTraeAccounts()
  emitSuccess(candidates, () => {
    if (isJsonMode()) return
    if (!candidates.length) {
      process.stdout.write(`${colors.dim('(no Trae candidates)')}\n`)
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

async function runImportToken(service: Service, text: string | undefined, type: string) {
  const tokenType = type.toLowerCase()
  if (tokenType !== 'refresh' && tokenType !== 'jwt') {
    throw new CliError('Trae token type must be refresh or jwt.', {
      code: ExitCode.UsageError,
      errorCode: 'INVALID_TOKEN_TYPE'
    })
  }
  const value = text ?? (await readStdin())
  if (!value) {
    throw new CliError('Provide Trae token text as argument or via stdin.', {
      code: ExitCode.UsageError,
      errorCode: 'MISSING_TOKEN'
    })
  }
  const result =
    tokenType === 'jwt'
      ? await service.addTraeJwtToken(value.trim())
      : await service.addTraeRefreshToken(value.trim())
  await notifyDaemonReload().catch(() => false)
  emitSuccess(result, () => process.stdout.write(`${colors.green('imported')} Trae ${tokenType}\n`))
}

async function runImportJson(service: Service, source: string | undefined) {
  let text: string
  if (!source || source === '-') text = await readStdin()
  else text = await readFile(source, 'utf8')
  if (!text) {
    throw new CliError('No Trae JSON content provided.', {
      code: ExitCode.UsageError,
      errorCode: 'MISSING_JSON'
    })
  }
  const result = await service.importTraeAuthJson(text)
  await notifyDaemonReload().catch(() => false)
  emitSuccess(result, () => {
    process.stdout.write(
      `${colors.green('imported')} added=${result.added}, skipped=${result.skipped}, errors=${result.errors.length}\n`
    )
  })
}

async function runImportScanned(service: Service, ids: string[]): Promise<void> {
  if (!ids.length) {
    throw new CliError('Provide at least one Trae account id.', {
      code: ExitCode.UsageError,
      errorCode: 'MISSING_IDS'
    })
  }
  const result = await service.importScannedTraeAccounts(ids)
  await notifyDaemonReload().catch(() => false)
  emitSuccess(result, () =>
    process.stdout.write(`${colors.green('imported')} ${result.added.length} Trae account(s)\n`)
  )
}

async function runTest(service: Service, id: string): Promise<void> {
  const result = await service.testTraeAccount(id)
  await notifyDaemonReload().catch(() => false)
  emitSuccess(result, () => {
    process.stdout.write(
      `${result.ok ? colors.green('ok') : colors.red('fail')} ${result.accountId}: ${result.message}\n`
    )
  })
}

async function runInfo(service: Service, id: string): Promise<void> {
  emitSuccess(await service.getTraeAccountInfo(id))
}

async function runRefreshModels(service: Service, id: string): Promise<void> {
  const result = await service.refreshTraeAccountModels(id)
  await notifyDaemonReload().catch(() => false)
  emitSuccess(result, () =>
    process.stdout.write(`${colors.green('models')} ${result.models.length}\n`)
  )
}

async function runToggle(service: Service, id: string, enabled: boolean): Promise<void> {
  await service.toggleTraeAccount(id, enabled)
  await notifyDaemonReload().catch(() => false)
  emitSuccess({ id, enabled }, () =>
    process.stdout.write(`${enabled ? colors.green('enabled') : colors.yellow('disabled')} ${id}\n`)
  )
}

async function runRemove(service: Service, id: string): Promise<void> {
  await service.removeTraeAccount(id)
  await notifyDaemonReload().catch(() => false)
  emitSuccess({ id, removed: true }, () =>
    process.stdout.write(`${colors.green('removed')} ${id}\n`)
  )
}

async function runReset(service: Service, id: string): Promise<void> {
  await service.resetTraeAccount(id)
  await notifyDaemonReload().catch(() => false)
  emitSuccess({ id, reset: true }, () => process.stdout.write(`${colors.green('reset')} ${id}\n`))
}

async function runSetStatus(
  service: Service,
  id: string,
  status: string,
  reason?: string
): Promise<void> {
  await service.setTraeAccountStatus(id, status as any, reason)
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
    const model = options.model.includes('/') ? options.model : `trae/${options.model}`
    const response = await fetch(`${target.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${target.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: Number.isFinite(options.maxTokens) ? options.maxTokens : 64,
        messages: [{ role: 'user', content: options.prompt }]
      }),
      signal: AbortSignal.timeout(180_000)
    })
    const payload = parseJsonText(await response.text()) as any
    if (!response.ok || payload?.error) {
      throw new CliError(
        `Trae chat failed: HTTP ${response.status} ${JSON.stringify(payload).slice(0, 800)}`,
        { code: ExitCode.GeneralError, errorCode: 'TRAE_CHAT_FAILED' }
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
  return Buffer.concat(chunks).toString('utf8')
}
