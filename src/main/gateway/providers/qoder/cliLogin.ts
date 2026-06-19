import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { chmod, cp, mkdir, readFile, rm, stat } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import type { QoderAccountConfig } from '../../types'
import { sha256Short, toErrorMessage } from '../../core/utils'
import { emitCliLoginEvent, type CliLoginOutputEvent } from '../../events/cliLoginEvents'

export interface QoderCliDetectResult {
  found: boolean
  path: string
  version?: string
}

export interface QoderCliLoginResult {
  success: boolean
  account?: QoderAccountConfig
  error?: string
}

type OnQoderAccountImported = (account: QoderAccountConfig) => Promise<void>

let onQoderAccountImported: OnQoderAccountImported | null = null

export function setOnQoderAccountImported(handler: OnQoderAccountImported): void {
  onQoderAccountImported = handler
}

interface LoginSession {
  process: ChildProcess
  tempHome: string
  fakeBinDir: string
  cancelled: boolean
  output: string
}

interface QoderStatusJson {
  logged_in?: boolean
  username?: string
  email?: string
  avatar_url?: string
  version?: string
  [key: string]: unknown
}

let activeSession: LoginSession | null = null

const MACOS_SANDBOX_PROFILE = `(version 1)
(allow default)
(deny mach-lookup (global-name-regex #"^com\\.apple\\.coreservices\\."))
(deny mach-lookup (global-name-regex #"^com\\.apple\\.lsd"))`

export async function detectQoderCli(customPath?: string): Promise<QoderCliDetectResult> {
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
    const resolved = execFileSync('which', ['qodercli'], { encoding: 'utf8', timeout: 5000 }).trim()
    if (resolved) {
      const version = getCliVersion(resolved)
      return { found: true, path: resolved, version }
    }
  } catch {
    /* not in PATH */
  }

  return { found: false, path: '' }
}

export function loginWithQoderCli(options: {
  cliPath?: string
  authStoreDir: string
  label?: string
}): void {
  if (activeSession) throw new Error('A Qoder CLI login is already in progress')

  const cliPath = options.cliPath || 'qodercli'
  const tempHome = mkdtempSync(join(tmpdir(), 'gatewayhub-qoder-cli-'))
  chmodSync(tempHome, 0o700)

  mkdirSync(join(tempHome, '.config'), { recursive: true })
  mkdirSync(join(tempHome, '.local', 'share'), { recursive: true })
  mkdirSync(join(tempHome, '.local', 'state'), { recursive: true })
  mkdirSync(join(tempHome, '.cache'), { recursive: true })

  const binDir = mkdtempSync(join(tmpdir(), 'gatewayhub-qoder-noopen-'))
  const fakeOpener = join(binDir, 'gatewayhub-noopen')
  writeFileSync(fakeOpener, '#!/bin/sh\nprintf "%s\\n" "$*" >&2\nexit 1\n')
  chmodSync(fakeOpener, 0o755)
  for (const name of [
    'open',
    'xdg-open',
    'gio',
    'gnome-open',
    'kde-open',
    'wslview',
    'cygstart',
    'start',
    'osascript'
  ]) {
    const p = join(binDir, name)
    writeFileSync(p, `#!/bin/sh\nexec "${fakeOpener}" "$@"\n`)
    chmodSync(p, 0o755)
  }

  const env = buildQoderLoginEnv(tempHome, binDir, fakeOpener)
  const child = spawn(...buildLoginSpawnArgs(cliPath), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env
  })

  const session: LoginSession = {
    process: child,
    tempHome,
    fakeBinDir: binDir,
    cancelled: false,
    output: ''
  }
  activeSession = session

  const send = (event: CliLoginOutputEvent): void => emitCliLoginEvent(event)

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
      cleanupDir(session.tempHome)
      return
    }

    if (code === 0) {
      const result = await extractAccountFromQoderHome({
        sourceHome: session.tempHome,
        authStoreDir: options.authStoreDir,
        qoderCliPath: cliPath,
        label: options.label
      })
      cleanupDir(session.tempHome)

      if (result.success && result.account && onQoderAccountImported) {
        try {
          await onQoderAccountImported(result.account)
          send({ type: 'exit', code: 0, imported: true })
        } catch (err: unknown) {
          send({
            type: 'exit',
            code: 0,
            imported: false,
            error: toErrorMessage(err) || 'Qoder account import failed'
          })
        }
      } else {
        send({
          type: 'exit',
          code: 0,
          imported: false,
          error: result.error || 'No Qoder import handler'
        })
      }
    } else {
      cleanupDir(session.tempHome)
      send({ type: 'exit', code })
    }
  })

  child.on('error', (err) => {
    if (activeSession === session) activeSession = null
    cleanupDir(session.fakeBinDir)
    cleanupDir(session.tempHome)
    if (!session.cancelled) send({ type: 'error', message: err.message })
  })
}

export function cancelQoderCliLogin(): boolean {
  if (!activeSession) return false
  activeSession.cancelled = true
  activeSession.process.kill('SIGTERM')
  activeSession = null
  return true
}

export async function importCurrentQoderCliAuth(options: {
  authStoreDir: string
  qoderCliPath?: string
  label?: string
  sourceHome?: string
}): Promise<QoderAccountConfig> {
  const detect = await detectQoderCli(options.qoderCliPath)
  if (!detect.found) {
    throw new Error(
      `qodercli not found${options.qoderCliPath ? ` at ${options.qoderCliPath}` : ' on PATH'}`
    )
  }
  const sourceHome = options.sourceHome || process.env.QODER_CLI_HOME || homedir()
  const result = await extractAccountFromQoderHome({
    sourceHome,
    authStoreDir: options.authStoreDir,
    qoderCliPath: detect.path,
    label: options.label
  })
  if (!result.success || !result.account) {
    throw new Error(result.error || 'Failed to import current qodercli auth')
  }
  return result.account
}

async function extractAccountFromQoderHome(options: {
  sourceHome: string
  authStoreDir: string
  qoderCliPath: string
  label?: string
}): Promise<QoderCliLoginResult> {
  try {
    const sourceAuthDir = join(options.sourceHome, '.qoder', '.auth')
    const userPath = join(sourceAuthDir, 'user')
    const machinePath = join(sourceAuthDir, 'machine_id')
    const [userBlob, machineId] = await Promise.all([
      readFile(userPath, 'utf8'),
      readFile(machinePath, 'utf8')
    ])
    const status = await readQoderStatusJson(options.qoderCliPath, options.sourceHome)
    if (!status.logged_in) return { success: false, error: 'qodercli is not logged in' }

    const email = normalizeEmail(status.email)
    const username = normalizeLabel(status.username)
    const fingerprint = sha256Short(`${userBlob}\n${machineId}`)
    const identity = email || username || fingerprint
    const id = `qoder-cli-${sha256Short(`${identity}:${fingerprint}`)}`
    const targetHome = join(options.authStoreDir, id)
    const targetAuthDir = join(targetHome, '.qoder', '.auth')

    await rm(targetHome, { recursive: true, force: true })
    await mkdir(targetAuthDir, { recursive: true })
    await cp(sourceAuthDir, targetAuthDir, { recursive: true, force: true })
    await Promise.all([
      chmod(targetHome, 0o700).catch(() => undefined),
      chmod(join(targetHome, '.qoder'), 0o700).catch(() => undefined),
      chmod(targetAuthDir, 0o700).catch(() => undefined)
    ])

    const copiedStatus = await readQoderStatusJson(options.qoderCliPath, targetHome)
    if (!copiedStatus.logged_in) {
      await rm(targetHome, { recursive: true, force: true }).catch(() => undefined)
      return { success: false, error: 'Copied Qoder auth bundle is not usable' }
    }

    return {
      success: true,
      account: {
        id,
        label: options.label?.trim() || email || username || 'Qoder CLI Login',
        email,
        enabled: true,
        authType: 'qoder-cli-auth',
        qoderCliPath: options.qoderCliPath,
        qoderCliHome: targetHome
      }
    }
  } catch (err: unknown) {
    return { success: false, error: `Failed to import Qoder auth bundle: ${toErrorMessage(err)}` }
  }
}

function readQoderStatusJson(cliPath: string, qoderCliHome: string): Promise<QoderStatusJson> {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, ['status', '-o', 'json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildQoderCommandEnv(qoderCliHome)
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      reject(new Error(`qodercli status timed out${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
    }, 15_000)
    timer.unref?.()

    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code && code !== 0) {
        reject(new Error(`qodercli status exited with code ${code}: ${stderr.trim()}`))
        return
      }
      try {
        resolve(JSON.parse(stdout.trim() || '{}') as QoderStatusJson)
      } catch (err) {
        reject(new Error(`Failed to parse qodercli status JSON: ${toErrorMessage(err)}`))
      }
    })
  })
}

function buildQoderLoginEnv(
  tempHome: string,
  fakeBinDir: string,
  fakeOpener: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tempHome,
    QODER_CLI_HOME: tempHome,
    XDG_CONFIG_HOME: join(tempHome, '.config'),
    XDG_DATA_HOME: join(tempHome, '.local', 'share'),
    XDG_STATE_HOME: join(tempHome, '.local', 'state'),
    XDG_CACHE_HOME: join(tempHome, '.cache'),
    BROWSER: fakeOpener,
    DISPLAY: '',
    WAYLAND_DISPLAY: ''
  }
  env.PATH = `${fakeBinDir}:${env.PATH || ''}`
  delete env.ELECTRON_RUN_AS_NODE
  scrubQoderAuthEnv(env)
  return env
}

function buildQoderCommandEnv(qoderCliHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    QODER_CLI_HOME: qoderCliHome
  }
  scrubQoderAuthEnv(env)
  return env
}

function scrubQoderAuthEnv(env: NodeJS.ProcessEnv): void {
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'QODER_PERSONAL_ACCESS_TOKEN'
  ]) {
    delete env[key]
  }
}

function buildLoginSpawnArgs(cliPath: string): [string, string[]] {
  const cliArgs = ['login']
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
  return [
    home ? `${home}/.local/bin/qodercli` : '',
    '/usr/local/bin/qodercli',
    '/opt/homebrew/bin/qodercli',
    '/usr/bin/qodercli'
  ].filter(Boolean)
}

function getCliVersion(path: string): string | undefined {
  try {
    return execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim()
  } catch {
    return undefined
  }
}

function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : undefined
}

function normalizeLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}
