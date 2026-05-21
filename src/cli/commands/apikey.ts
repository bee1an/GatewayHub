import type { CAC } from 'cac'
import { ensureServiceInitialized } from '../bootstrap'
import { CliError, ExitCode } from '../framework/errors'
import { colors, emitSuccess, isJsonMode, printTable } from '../framework/output'
import { notifyDaemonReload } from '../daemon/controller'

const ACTIONS = ['list', 'create', 'revoke', 'update'] as const
type Action = (typeof ACTIONS)[number]

export function registerApikeyCommands(cli: CAC): void {
  cli
    .command('apikey <action> [id]', `API key management (${ACTIONS.join('|')})`)
    .option('--name <name>', 'Key name (create/update)')
    .option('--expires <iso>', 'Expiration ISO date (create/update)')
    .option('--scopes <list>', 'Comma-separated scopes (create/update)')
    .option('--clear-expires', 'Remove expiration on update')
    .option('--clear-scopes', 'Remove scopes on update')
    .action(
      async (
        action: string,
        id: string | undefined,
        options: {
          name?: string
          expires?: string
          scopes?: string
          clearExpires?: boolean
          clearScopes?: boolean
        }
      ) => {
        if (!ACTIONS.includes(action as Action)) {
          throw new CliError(
            `Unknown apikey action: ${action}. Expected one of ${ACTIONS.join(', ')}.`,
            { code: ExitCode.UsageError, errorCode: 'UNKNOWN_ACTION' }
          )
        }
        const service = await ensureServiceInitialized()
        switch (action as Action) {
          case 'list':
            return runList(service)
          case 'create':
            return runCreate(service, options)
          case 'revoke':
            return runRevoke(service, requireId(id))
          case 'update':
            return runUpdate(service, requireId(id), options)
        }
      }
    )
}

function requireId(id?: string): string {
  if (!id) {
    throw new CliError('Missing argument: <id>', {
      code: ExitCode.UsageError,
      errorCode: 'MISSING_ARG'
    })
  }
  return id
}

async function runList(
  service: Awaited<ReturnType<typeof ensureServiceInitialized>>
): Promise<void> {
  const status = await service.getStatus()
  const keys = status.server.apiKeys
  emitSuccess(keys, () => {
    if (isJsonMode()) return
    if (keys.length === 0) {
      process.stdout.write(`${colors.dim('(no api keys)')}\n`)
      return
    }
    printTable(keys, [
      { header: 'ID', get: (k) => k.id },
      { header: 'NAME', get: (k) => k.name },
      { header: 'KEY', get: (k) => `${k.key.slice(0, 12)}...${k.key.slice(-4)}` },
      {
        header: 'EXPIRES',
        get: (k) => (k.expiresAt ? new Date(k.expiresAt).toISOString() : colors.dim('never'))
      },
      {
        header: 'SCOPES',
        get: (k) => (k.scopes?.length ? k.scopes.join(',') : colors.dim('all'))
      }
    ])
  })
}

async function runCreate(
  service: Awaited<ReturnType<typeof ensureServiceInitialized>>,
  options: { name?: string; expires?: string; scopes?: string }
): Promise<void> {
  const before = await service.getStatus()
  const beforeIds = new Set(before.server.apiKeys.map((k) => k.id))
  await service.generateNewApiKey({
    name: options.name ?? 'Untitled',
    expiresAt: options.expires ? Date.parse(options.expires) : undefined,
    scopes: options.scopes
      ? options.scopes
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined
  })
  const after = await service.getStatus()
  const created = after.server.apiKeys.find((k) => !beforeIds.has(k.id))
  await notifyDaemonReload().catch(() => false)
  emitSuccess(created, () => {
    if (!created) return
    process.stdout.write(`${colors.green('created')} ${created.id}\n`)
    process.stdout.write(`  name    ${created.name}\n`)
    process.stdout.write(`  key     ${created.key}\n`)
    if (created.expiresAt) {
      process.stdout.write(`  expires ${new Date(created.expiresAt).toISOString()}\n`)
    }
  })
}

async function runRevoke(
  service: Awaited<ReturnType<typeof ensureServiceInitialized>>,
  id: string
): Promise<void> {
  await service.revokeApiKey(id)
  await notifyDaemonReload().catch(() => false)
  emitSuccess({ id, revoked: true }, () => {
    process.stdout.write(`${colors.green('revoked')} ${id}\n`)
  })
}

async function runUpdate(
  service: Awaited<ReturnType<typeof ensureServiceInitialized>>,
  id: string,
  options: {
    name?: string
    expires?: string
    scopes?: string
    clearExpires?: boolean
    clearScopes?: boolean
  }
): Promise<void> {
  const updates: { name?: string; expiresAt?: number | null; scopes?: string[] | null } = {}
  if (options.name !== undefined) updates.name = options.name
  if (options.clearExpires) updates.expiresAt = null
  else if (options.expires !== undefined) updates.expiresAt = Date.parse(options.expires)
  if (options.clearScopes) updates.scopes = null
  else if (options.scopes !== undefined)
    updates.scopes = options.scopes
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  await service.updateApiKey(id, updates)
  await notifyDaemonReload().catch(() => false)
  emitSuccess({ id, updates }, () => {
    process.stdout.write(`${colors.green('updated')} ${id}\n`)
  })
}
