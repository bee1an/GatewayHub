import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomBytes, randomUUID } from 'crypto'
import { mkdir, unlink } from 'fs/promises'
import { isAbsolute, join } from 'path'
import { homedir, tmpdir } from 'os'
import net from 'net'
import type { WindsurfAccountConfig, WindsurfProviderSettings } from '../../types'
import { sleep, toErrorMessage } from '../../core/utils'
import {
  DEFAULT_WINDSURF_IDE_VERSION,
  resolveWindsurfExtensionDir,
  resolveWindsurfLanguageServerBinary
} from './constants'

export class WindsurfLanguageServerClient {
  private process?: ChildProcessWithoutNullStreams
  private port = 0
  private lspPort = 0
  private readonly csrfToken = randomBytes(16).toString('hex')
  private readonly sessionId = `gatewayhub-${randomUUID()}`
  private requestId = 0
  private stderrTail = ''
  private started = false
  private parentServer?: net.Server
  private parentPipePath?: string

  constructor(
    private readonly account: WindsurfAccountConfig,
    private readonly settings: WindsurfProviderSettings,
    private readonly runtimeDir: string
  ) {}

  async ensureStarted(): Promise<void> {
    if (this.started && this.process && !this.process.killed) return
    await mkdir(this.runtimeDir, { recursive: true })
    this.port = await getFreePort()
    this.lspPort = await getFreePort()
    const extensionServerPort = await getFreePort()
    const binary = resolveWindsurfLanguageServerBinary(this.settings.languageServerBinaryPath)
    const extensionDir = resolveWindsurfExtensionDir()
    const parentPipe = await createParentPipe()
    this.parentServer = parentPipe.server
    this.parentPipePath = parentPipe.pipePath
    const args = [
      '--api_server_url',
      this.account.apiServerUrl || this.settings.apiServerUrl,
      '--run_child',
      '--enable_lsp',
      '--extension_server_port',
      String(extensionServerPort),
      '--ide_name',
      'windsurf',
      '--inference_api_server_url',
      this.account.inferenceApiServerUrl || this.settings.inferenceApiServerUrl,
      '--server_port',
      String(this.port),
      '--lsp_port',
      String(this.lspPort),
      '--csrf_token',
      this.csrfToken,
      '--codeium_dir',
      resolveCodeiumDirArg(this.settings.codeiumDir),
      '--database_dir',
      join(this.runtimeDir, 'database', '9c0694567290725d9dcba14ade58e297'),
      '--enable_index_service',
      '--enable_local_search',
      '--search_max_workspace_file_count',
      '50000',
      '--indexed_files_retention_period_days',
      '30',
      '--sentry_telemetry',
      '--sentry_environment',
      'stable',
      '--extensions_dir',
      extensionDir,
      '--parent_pipe_path',
      parentPipe.pipePath,
      '--windsurf_version',
      DEFAULT_WINDSURF_IDE_VERSION,
      '--stdin_initial_metadata',
      `--detect_proxy=${this.settings.detectProxy !== false}`,
      '--workspace_id',
      'gatewayhub'
    ]

    const child = spawn(binary, args, {
      cwd: undefined,
      env: {
        ...process.env,
        CODEIUM_EDITOR_APP_ROOT: '/Applications/Windsurf.app/Contents/Resources/app',
        WINDSURF_CSRF_TOKEN: this.csrfToken
      }
    })
    this.process = child
    child.stdin.write(this.metadataBinary())
    child.stdin.end()
    child.stdout.on('data', () => {
      // language_server stdout is noisy and may contain local diagnostics; intentionally discard.
    })
    child.stderr.on('data', (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      this.stderrTail = (this.stderrTail + text).slice(-20_000)
    })
    child.on('error', (error) => {
      this.stderrTail = (this.stderrTail + toErrorMessage(error)).slice(-20_000)
    })

    const ready = await waitForPort(this.port, this.settings.launchTimeoutSeconds * 1000)
    if (!ready) {
      await this.dispose()
      throw new Error(`Windsurf language server failed to start: ${this.stderrTail.slice(-1000)}`)
    }
    this.started = true
  }

  async dispose(): Promise<void> {
    this.started = false
    const child = this.process
    this.process = undefined
    const parentServer = this.parentServer
    const parentPipePath = this.parentPipePath
    this.parentServer = undefined
    this.parentPipePath = undefined
    const cleanupParent = async () => {
      parentServer?.close()
      if (parentPipePath) await unlink(parentPipePath).catch(() => {})
    }
    if (!child || child.killed) {
      await cleanupParent()
      return
    }
    child.kill('SIGTERM')
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(1500).then(() => {
        if (!child.killed) child.kill('SIGKILL')
      })
    ]).catch(() => {})
    await cleanupParent()
  }

  metadata(): Record<string, unknown> {
    this.requestId += 1
    return {
      ideName: 'windsurf',
      ideVersion: DEFAULT_WINDSURF_IDE_VERSION,
      ideType: 'desktop',
      extensionName: 'windsurf',
      extensionVersion: '0.2.0',
      extensionPath: resolveWindsurfExtensionDir(),
      apiKey: this.account.apiKey || '',
      sessionId: this.sessionId,
      requestId: String(this.requestId),
      locale: 'en',
      planName: 'Unset',
      os: process.platform,
      hardware: process.arch,
      teamId: undefined
    }
  }

  async unary(method: string, body: Record<string, unknown>, timeoutMs?: number): Promise<any> {
    await this.ensureStarted()
    const controller = timeoutMs ? new AbortController() : undefined
    const timer = timeoutMs ? setTimeout(() => controller?.abort(), timeoutMs) : undefined
    let response: Response
    try {
      response = await fetch(this.methodUrl(method), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'connect-protocol-version': '1',
          'x-codeium-csrf-token': this.csrfToken
        },
        body: JSON.stringify(body),
        signal: controller?.signal
      })
    } catch (error) {
      if ((error as any)?.name === 'AbortError') {
        throw new Error(
          `Windsurf ${method} timed out after ${Math.round((timeoutMs || 0) / 1000)}s`
        )
      }
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
    const text = await response.text()
    const parsed = text ? safeJson(text) : undefined
    if (!response.ok) {
      const message = parsed?.message || parsed?.error?.message || text || response.statusText
      throw new Error(`Windsurf HTTP ${response.status}: ${message}`)
    }
    return parsed
  }

  private metadataBinary(): Buffer {
    const metadata = this.metadata()
    const parts: Buffer[] = []
    writeString(parts, 1, metadata.ideName)
    writeString(parts, 7, metadata.ideVersion)
    writeString(parts, 28, metadata.ideType)
    writeString(parts, 12, metadata.extensionName)
    writeString(parts, 2, metadata.extensionVersion)
    writeString(parts, 3, metadata.apiKey)
    writeString(parts, 4, metadata.locale)
    writeString(parts, 5, metadata.os)
    writeString(parts, 8, metadata.hardware)
    writeBool(parts, 6, false)
    writeString(parts, 10, metadata.sessionId)
    writeUInt(parts, 9, this.requestId)
    writeString(parts, 17, metadata.extensionPath)
    writeString(parts, 26, metadata.planName)
    return Buffer.concat(parts)
  }

  private methodUrl(method: string): string {
    return `http://127.0.0.1:${this.port}/exa.language_server_pb.LanguageServerService/${method}`
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Failed to allocate a local port'))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.destroy()
          resolve()
        })
        socket.on('error', reject)
        socket.setTimeout(500, () => {
          socket.destroy()
          reject(new Error('timeout'))
        })
      })
      return true
    } catch {
      await sleep(200)
    }
  }
  return false
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(
      `Invalid Windsurf JSON response: ${toErrorMessage(error)}: ${text.slice(0, 300)}`
    )
  }
}

export function windsurfRuntimeDir(accountId: string): string {
  return join(tmpdir(), 'gatewayhub-windsurf', accountId.replace(/[^a-zA-Z0-9_.-]/g, '_'))
}

function resolveCodeiumDirArg(value?: string): string {
  const configured = value?.trim() || '.codeium/windsurf'
  if (configured.startsWith('~/')) return join(homedir(), configured.slice(2))
  return isAbsolute(configured) ? configured : configured
}

async function createParentPipe(): Promise<{ pipePath: string; server: net.Server }> {
  const pipePath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\gatewayhub_windsurf_${randomBytes(8).toString('hex')}`
      : join(tmpdir(), `gatewayhub-windsurf-parent-${randomBytes(8).toString('hex')}`)
  if (process.platform !== 'win32') await unlink(pipePath).catch(() => {})
  const server = net.createServer((socket) => {
    socket.on('error', () => {})
    socket.resume()
  })
  await new Promise<void>((resolve, reject) => {
    server.listen(pipePath, resolve)
    server.on('error', reject)
  })
  return { pipePath, server }
}

function writeString(parts: Buffer[], field: number, value: unknown): void {
  if (typeof value !== 'string' || !value) return
  const data = Buffer.from(value, 'utf8')
  parts.push(varint((field << 3) | 2), varint(data.length), data)
}

function writeUInt(parts: Buffer[], field: number, value: unknown): void {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number < 0) return
  parts.push(varint((field << 3) | 0), varint(BigInt(Math.trunc(number))))
}

function writeBool(parts: Buffer[], field: number, value: boolean): void {
  parts.push(varint((field << 3) | 0), Buffer.from([value ? 1 : 0]))
}

function varint(value: number | bigint): Buffer {
  let n = typeof value === 'bigint' ? value : BigInt(value)
  const bytes: number[] = []
  while (n >= 0x80n) {
    bytes.push(Number((n & 0x7fn) | 0x80n))
    n >>= 7n
  }
  bytes.push(Number(n))
  return Buffer.from(bytes)
}
