import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from 'fs'
import { stat } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { BrowserWindow } from 'electron'
import { SQLITE_TOKEN_KEYS, SQLITE_REGISTRATION_KEYS } from './constants'
import type { KiroAccountConfig } from '../../types'
import { sha256Short } from '../../core/utils'

export interface CliDetectResult {
  found: boolean
  path: string
  version?: string
}

export interface CliLoginResult {
  success: boolean
  account?: KiroAccountConfig
  error?: string
}

type OnAccountImported = (account: KiroAccountConfig) => Promise<void>

let onAccountImported: OnAccountImported | null = null

export function setOnAccountImported(handler: OnAccountImported): void {
  onAccountImported = handler
}

interface LoginSession {
  process: ChildProcess
  tempProfileDir: string
  fakeBinDir: string
  cancelled: boolean
  output: string
}

let activeSession: LoginSession | null = null

const MACOS_SANDBOX_PROFILE = `(version 1)
(allow default)
(deny mach-lookup (global-name-regex #"^com\\.apple\\.coreservices\\."))
(deny mach-lookup (global-name-regex #"^com\\.apple\\.lsd"))`

export async function detectKiroCli(customPath?: string): Promise<CliDetectResult> {
  const candidates = customPath ? [customPath] : getDefaultCliPaths()

  for (const p of candidates) {
    try {
      await stat(p)
      const version = getCliVersion(p)
      return { found: true, path: p, version }
    } catch {
      continue
    }
  }

  try {
    const resolved = execFileSync('which', ['kiro-cli'], { encoding: 'utf8', timeout: 5000 }).trim()
    if (resolved) {
      const version = getCliVersion(resolved)
      return { found: true, path: resolved, version }
    }
  } catch {
    /* not in PATH */
  }

  return { found: false, path: '' }
}

export function loginWithKiroCli(options?: { cliPath?: string }): void {
  if (activeSession) throw new Error('A CLI login is already in progress')

  const cliPath = options?.cliPath || 'kiro-cli'

  const profileDir = mkdtempSync(join(tmpdir(), 'gatewayhub-cli-'))
  chmodSync(profileDir, 0o700)

  const tempConfig = join(profileDir, '.config')
  const tempData = join(profileDir, '.local', 'share')
  const tempState = join(profileDir, '.local', 'state')
  const tempCache = join(profileDir, '.cache')
  mkdirSync(tempConfig, { recursive: true })
  mkdirSync(tempData, { recursive: true })
  mkdirSync(tempState, { recursive: true })
  mkdirSync(tempCache, { recursive: true })

  if (process.platform === 'darwin') {
    const keychainDir = join(profileDir, 'Library', 'Keychains')
    mkdirSync(keychainDir, { recursive: true })
    const keychainPath = join(keychainDir, 'login.keychain-db')
    try {
      execFileSync('/usr/bin/security', ['create-keychain', '-p', '', keychainPath], { stdio: 'ignore' })
      execFileSync('/usr/bin/security', ['unlock-keychain', '-p', '', keychainPath], { stdio: 'ignore' })
      execFileSync('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', keychainPath], { stdio: 'ignore' })
      execFileSync('/usr/bin/security', ['default-keychain', '-d', 'user', '-s', keychainPath], { stdio: 'ignore' })
    } catch {
      /* keychain creation failed; CLI may still prompt but flow can continue */
    }
  }

  const binDir = mkdtempSync(join(tmpdir(), 'gatewayhub-noopen-'))
  const fakeOpener = join(binDir, 'gatewayhub-noopen')
  writeFileSync(fakeOpener, '#!/bin/sh\nprintf "%s\\n" "$*" >&2\nexit 1\n')
  chmodSync(fakeOpener, 0o755)
  for (const name of ['open', 'xdg-open', 'gio', 'gnome-open', 'kde-open', 'wslview', 'cygstart', 'start', 'osascript']) {
    const p = join(binDir, name)
    writeFileSync(p, `#!/bin/sh\nexec "${fakeOpener}" "$@"\n`)
    chmodSync(p, 0o755)
  }

  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: profileDir,
    XDG_CONFIG_HOME: tempConfig,
    XDG_DATA_HOME: tempData,
    XDG_STATE_HOME: tempState,
    XDG_CACHE_HOME: tempCache,
    BROWSER: fakeOpener,
    DISPLAY: '',
    WAYLAND_DISPLAY: '',
    ELECTRON_RUN_AS_NODE: undefined
  }
  env.PATH = `${binDir}:${env.PATH || ''}`

  const child = spawn(...buildSpawnArgs(cliPath), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env
  })

  const session: LoginSession = {
    process: child,
    tempProfileDir: profileDir,
    fakeBinDir: binDir,
    cancelled: false,
    output: ''
  }
  activeSession = session

  const send = (data: any) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.webContents.send('gateway:cliLoginOutput', data)
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    session.output += text
    if (!session.cancelled) send({ type: 'stdout', text })
  })

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    session.output += text
    if (!session.cancelled) send({ type: 'stderr', text })
  })

  child.on('close', async (code) => {
    if (activeSession === session) activeSession = null
    cleanupDir(session.fakeBinDir)

    if (session.cancelled) {
      cleanupDir(session.tempProfileDir)
      return
    }

    const alreadyLoggedIn = /already logged in/i.test(session.output)
    if (code === 0 || alreadyLoggedIn) {
      const result = extractAccountFromProfile(session.tempProfileDir)
      cleanupDir(session.tempProfileDir)

      if (result.success && result.account && onAccountImported) {
        try {
          await onAccountImported(result.account)
          send({ type: 'exit', code: 0, imported: true })
        } catch (err: any) {
          send({ type: 'exit', code: 0, imported: false, error: err?.message || 'Import failed' })
        }
      } else {
        send({ type: 'exit', code: 0, imported: false, error: result.error || 'No import handler' })
      }
    } else {
      cleanupDir(session.tempProfileDir)
      send({ type: 'exit', code })
    }
  })

  child.on('error', (err) => {
    if (activeSession === session) activeSession = null
    cleanupDir(session.fakeBinDir)
    cleanupDir(session.tempProfileDir)
    if (!session.cancelled) {
      send({ type: 'error', message: err.message })
    }
  })
}

export function cancelKiroCliLogin(): boolean {
  if (!activeSession) return false
  activeSession.cancelled = true
  activeSession.process.kill('SIGTERM')
  // close event will handle cleanup using the captured session reference
  activeSession = null
  return true
}

function extractAccountFromProfile(profileDir: string): CliLoginResult {
  const candidates = [
    join(profileDir, 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3'),
    join(profileDir, '.local', 'share', 'kiro-cli', 'data.sqlite3')
  ]

  for (const dbPath of candidates) {
    if (!existsSync(dbPath)) continue

    try {
      const sqlite = require('node:sqlite')
      const db = new sqlite.DatabaseSync(dbPath)
      try {
        let refreshToken = ''
        let accessToken = ''
        let profileArn = ''
        let region = ''
        let expiresAt = ''
        let clientId = ''
        let clientSecret = ''

        for (const key of SQLITE_TOKEN_KEYS) {
          const row = db.prepare('SELECT value FROM auth_kv WHERE key = ?').get(key) as { value?: string } | undefined
          if (!row?.value) continue
          const tokenJson = JSON.parse(row.value)
          accessToken = tokenJson.access_token || tokenJson.accessToken || ''
          refreshToken = tokenJson.refresh_token || tokenJson.refreshToken || ''
          profileArn = tokenJson.profile_arn || tokenJson.profileArn || ''
          region = tokenJson.region || ''
          expiresAt = tokenJson.expires_at || tokenJson.expiresAt || ''
          break
        }

        for (const key of SQLITE_REGISTRATION_KEYS) {
          const row = db.prepare('SELECT value FROM auth_kv WHERE key = ?').get(key) as { value?: string } | undefined
          if (!row?.value) continue
          const reg = JSON.parse(row.value)
          clientId = reg.client_id || reg.clientId || ''
          clientSecret = reg.client_secret || reg.clientSecret || ''
          if (reg.region && !region) region = reg.region
          break
        }

        try {
          const row = db.prepare("SELECT value FROM state WHERE key = 'api.codewhisperer.profile'").get() as { value?: string } | undefined
          if (row?.value) {
            const profile = JSON.parse(row.value)
            if (profile.arn && !profileArn) profileArn = profile.arn
          }
        } catch {
          // older databases may not have state table
        }

        if (!refreshToken && !accessToken) continue

        const id = profileArn
          ? `kiro-profile-${sha256Short(profileArn)}`
          : refreshToken
            ? `kiro-refresh-${sha256Short(refreshToken)}`
            : `kiro-access-${sha256Short(accessToken)}`

        const account: KiroAccountConfig = {
          id,
          enabled: true,
          label: `CLI ${new Date().toLocaleDateString()}`,
          refreshToken: refreshToken || undefined,
          accessToken: accessToken || undefined,
          expiresAt: expiresAt || undefined,
          profileArn: profileArn || undefined,
          clientId: clientId || undefined,
          clientSecret: clientSecret || undefined,
          region: region || 'us-east-1'
        }

        return { success: true, account }
      } finally {
        db.close()
      }
    } catch (err: any) {
      return { success: false, error: `Failed to parse SQLite: ${err?.message || err}` }
    }
  }

  return { success: false, error: 'No kiro-cli database found in temp profile' }
}

function buildSpawnArgs(cliPath: string): [string, string[]] {
  const cliArgs = ['login', '--license', 'free', '--use-device-flow']
  if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    return ['/usr/bin/sandbox-exec', ['-p', MACOS_SANDBOX_PROFILE, cliPath, ...cliArgs]]
  }
  return [cliPath, cliArgs]
}

function cleanupDir(dir: string | null): void {
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

function getDefaultCliPaths(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  return [`${home}/.local/bin/kiro-cli`, '/usr/local/bin/kiro-cli', '/opt/homebrew/bin/kiro-cli']
}

function getCliVersion(path: string): string | undefined {
  try {
    return execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim()
  } catch {
    return undefined
  }
}
