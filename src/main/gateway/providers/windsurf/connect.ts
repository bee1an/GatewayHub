import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomBytes, randomUUID } from 'crypto'
import { mkdir, unlink } from 'fs/promises'
import { isAbsolute, join } from 'path'
import { homedir, tmpdir } from 'os'
import net from 'net'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import type { WindsurfAccountConfig, WindsurfProviderSettings } from '../../types'
import { sleep, toErrorMessage } from '../../core/utils'
import {
  DEFAULT_WINDSURF_IDE_VERSION,
  resolveWindsurfExtensionDir,
  resolveWindsurfLanguageServerBinary
} from './constants'

export interface WindsurfCapturedCascadeEdit {
  uri?: string
  targetContent?: string
  cascadeId?: string
  gitWorktreePath?: string
  notebookCell?: any
  receivedAt: number
}

export class WindsurfLanguageServerClient {
  private process?: ChildProcessWithoutNullStreams
  private port = 0
  private lspPort = 0
  private extensionServerPort = 0
  private readonly csrfToken = randomBytes(16).toString('hex')
  private readonly sessionId = `gatewayhub-${randomUUID()}`
  private requestId = 0
  private stderrTail = ''
  private started = false
  private parentServer?: net.Server
  private parentPipePath?: string
  private extensionServer?: net.Server
  private readonly capturedCascadeEdits: WindsurfCapturedCascadeEdit[] = []

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
    this.extensionServerPort = await getFreePort()
    this.extensionServer = await createExtensionServer(this.extensionServerPort, (edit) => {
      this.capturedCascadeEdits.push(edit)
      if (this.capturedCascadeEdits.length > 500) {
        this.capturedCascadeEdits.splice(0, this.capturedCascadeEdits.length - 500)
      }
    })
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
      String(this.extensionServerPort),
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
        ...proxyEnv(this.settings.vpnProxyUrl),
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
    const extensionServer = this.extensionServer
    this.parentServer = undefined
    this.parentPipePath = undefined
    this.extensionServer = undefined
    const cleanupParent = async () => {
      parentServer?.close()
      extensionServer?.close()
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

  getCapturedCascadeEdits(cascadeId?: string): WindsurfCapturedCascadeEdit[] {
    const edits = cascadeId
      ? this.capturedCascadeEdits.filter((edit) => edit.cascadeId === cascadeId)
      : this.capturedCascadeEdits
    return edits.map((edit) => ({ ...edit }))
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

async function createExtensionServer(
  port: number,
  onCascadeEdit: (edit: WindsurfCapturedCascadeEdit) => void
): Promise<net.Server> {
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST') {
        writeJson(res, 404, { error: 'not_found' })
        return
      }
      const path = req.url?.split('?')[0] || ''
      const body = await readJsonBody(req)
      if (path.endsWith('/WriteCascadeEdit')) {
        onCascadeEdit({
          uri: stringField(body?.uri),
          targetContent: stringField(body?.targetContent ?? body?.target_content),
          cascadeId: stringField(body?.cascadeId ?? body?.cascade_id),
          gitWorktreePath: stringField(body?.gitWorktreePath ?? body?.git_worktree_path),
          notebookCell: body?.notebookCell ?? body?.notebook_cell,
          receivedAt: Date.now()
        })
      }
      writeJson(res, 200, {})
    } catch (error) {
      writeJson(res, 500, { message: toErrorMessage(error) })
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.listen(port, '127.0.0.1', resolve)
    server.on('error', reject)
  })
  return server
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function writeJson(res: ServerResponse, status: number, body: any): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.setHeader('connect-protocol-version', '1')
  res.end(JSON.stringify(body))
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
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

function proxyEnv(proxyUrl?: string): NodeJS.ProcessEnv {
  const trimmed = proxyUrl?.trim()
  if (!trimmed) return {}
  return {
    HTTP_PROXY: trimmed,
    HTTPS_PROXY: trimmed,
    ALL_PROXY: trimmed,
    http_proxy: trimmed,
    https_proxy: trimmed,
    all_proxy: trimmed
  }
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
