import type { CAC } from 'cac'
import { symlink, unlink, stat, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { CliError, ExitCode } from '../framework/errors'
import { colors, emitSuccess } from '../framework/output'

const SHELL_ACTIONS = ['install-shim', 'uninstall-shim'] as const

export function registerShellCommands(cli: CAC): void {
  cli
    .command('shell <action>', 'CLI shim management (install-shim|uninstall-shim)')
    .action(async (action: string) => {
      if (!SHELL_ACTIONS.includes(action as any)) {
        throw new CliError(
          `Unknown shell action: ${action}. Expected one of ${SHELL_ACTIONS.join(', ')}.`,
          { code: ExitCode.UsageError, errorCode: 'UNKNOWN_ACTION' }
        )
      }
      if (action === 'install-shim') return installShim()
      return uninstallShim()
    })
}

async function installShim(): Promise<void> {
  const binDir = join(homedir(), '.local', 'bin')
  const shimPath = join(binDir, 'gatewayhub')
  const target = process.argv[1] // path to cli.js

  await mkdir(binDir, { recursive: true })

  try {
    await stat(shimPath)
    await unlink(shimPath)
  } catch {
    /* doesn't exist yet */
  }

  await symlink(target, shimPath)

  emitSuccess({ shimPath, target }, () => {
    process.stdout.write(`${colors.green('installed')} ${shimPath} → ${target}\n`)
    if (!process.env.PATH?.includes(binDir)) {
      process.stdout.write(
        `${colors.yellow('note:')} ${binDir} is not in PATH. Add to your shell profile:\n`
      )
      process.stdout.write(`  export PATH="${binDir}:$PATH"\n`)
    }
  })
}

async function uninstallShim(): Promise<void> {
  const shimPath = join(homedir(), '.local', 'bin', 'gatewayhub')
  try {
    await unlink(shimPath)
    emitSuccess({ shimPath, removed: true }, () =>
      process.stdout.write(`${colors.green('removed')} ${shimPath}\n`)
    )
  } catch {
    emitSuccess({ shimPath, removed: false }, () =>
      process.stdout.write(`${colors.dim('shim not found at')} ${shimPath}\n`)
    )
  }
}
