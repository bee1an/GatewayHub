import { createInterface } from 'readline'
import { existsSync } from 'fs'
import { delimiter, join, resolve } from 'path'
import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import type { GptWebAccountConfig, GptWebProviderSettings } from '../../types'
import type { GptWebRequestContext } from './http'

type WorkerInput =
  | {
      kind: 'models'
      account: GptWebAccountConfig
      settings: GptWebProviderSettings
    }
  | {
      kind: 'chat-stream'
      account: GptWebAccountConfig
      settings: GptWebProviderSettings
      body: Record<string, unknown>
    }

interface ModelsWorkerOutput {
  ok: true
  models: string[]
}

type StreamWorkerMessage =
  | { type: 'line'; line: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

let cachedNodePath: string | null | undefined
let cachedCliPath: string | null | undefined

export function shouldUseNodeBridge(): boolean {
  const versions = process.versions as NodeJS.ProcessVersions & { electron?: string }
  return (
    process.env.GATEWAYHUB_GPT_WEB_DISABLE_NODE_BRIDGE !== '1' &&
    process.env.GATEWAYHUB_GPT_WEB_NODE_BRIDGE !== '1' &&
    Boolean(versions.electron)
  )
}

export async function fetchModelsViaNodeBridge(ctx: GptWebRequestContext): Promise<string[]> {
  const output = await runWorkerJson<ModelsWorkerOutput>({
    kind: 'models',
    account: ctx.account,
    settings: ctx.settings
  })
  return output.models
}

export async function* streamConversationViaNodeBridge(
  ctx: GptWebRequestContext,
  body: Record<string, unknown>
): AsyncGenerator<string> {
  const child = spawnWorker({
    kind: 'chat-stream',
    account: ctx.account,
    settings: ctx.settings,
    body
  })
  const stderrChunks: Buffer[] = []
  const queue: string[] = []
  let done = false
  let error: Error | undefined
  let notify: (() => void) | undefined

  const wake = (): void => {
    notify?.()
    notify = undefined
  }
  const wait = (): Promise<void> =>
    new Promise((resolveWait) => {
      notify = resolveWait
    })

  child.stderr.on('data', (chunk) => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    if (Buffer.concat(stderrChunks).length > 8192) stderrChunks.shift()
  })

  const rl = createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    if (!line.trim()) return
    try {
      const message = JSON.parse(line) as StreamWorkerMessage
      if (message.type === 'line') {
        queue.push(message.line)
      } else if (message.type === 'error') {
        error = new Error(message.message)
      } else if (message.type === 'done') {
        done = true
      }
    } catch {
      error = new Error(`Invalid GptWeb worker output: ${line.slice(0, 200)}`)
    }
    wake()
  })
  child.on('error', (err) => {
    error = err
    done = true
    wake()
  })
  child.on('close', (code) => {
    done = true
    if (code && !error) {
      error = new Error(
        `GptWeb Node worker exited with code ${code}: ${Buffer.concat(stderrChunks)
          .toString('utf8')
          .slice(0, 800)}`
      )
    }
    wake()
  })
  ctx.signal?.addEventListener(
    'abort',
    () => {
      error = new Error('GptWeb request aborted')
      child.kill('SIGTERM')
      done = true
      wake()
    },
    { once: true }
  )

  child.stdin.end(
    JSON.stringify({ kind: 'chat-stream', account: ctx.account, settings: ctx.settings, body })
  )

  try {
    while (!done || queue.length) {
      if (error) throw error
      const next = queue.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      await wait()
    }
    if (error) throw error
  } finally {
    if (!child.killed && !done) child.kill('SIGTERM')
    rl.close()
  }
}

async function runWorkerJson<T>(input: WorkerInput): Promise<T> {
  const nodePath = resolveSystemNodePath()
  const cliPath = resolveCliEntryPath()

  return new Promise<T>((resolvePromise, reject) => {
    const child = execFile(
      nodePath,
      [cliPath, '__gptWeb-upstream'],
      {
        env: buildWorkerEnv(),
        timeout: 180_000,
        maxBuffer: 1024 * 1024 * 8
      },
      (error, stdout, stderr) => {
        if (error) {
          const workerMessage = parseWorkerError(stdout)
          reject(
            new Error(
              `GptWeb Node worker failed: ${
                workerMessage || stderr?.toString().trim() || error.message
              }`.slice(0, 1200)
            )
          )
          return
        }
        try {
          const parsed = JSON.parse(stdout) as T
          resolvePromise(parsed)
        } catch (err) {
          reject(
            new Error(
              `Invalid GptWeb Node worker JSON: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          )
        }
      }
    )
    child.stdin?.end(JSON.stringify(input))
  })
}

function parseWorkerError(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout.trim()) as { type?: string; message?: string }
    if (parsed.type === 'error' && parsed.message) return parsed.message
  } catch {
    return undefined
  }
  return undefined
}

function spawnWorker(inputForErrorContext: WorkerInput): ChildProcessWithoutNullStreams {
  const nodePath = resolveSystemNodePath()
  const cliPath = resolveCliEntryPath()
  const child = spawn(nodePath, [cliPath, '__gptWeb-upstream'], {
    env: buildWorkerEnv(),
    stdio: 'pipe'
  })
  child.on('error', (error) => {
    error.message = `Failed to start GptWeb Node worker for ${inputForErrorContext.kind}: ${error.message}`
  })
  return child
}

function buildWorkerEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GATEWAYHUB_GPT_WEB_NODE_BRIDGE: '1',
    ELECTRON_RUN_AS_NODE: ''
  }
}

function resolveSystemNodePath(): string {
  if (cachedNodePath !== undefined) {
    if (cachedNodePath) return cachedNodePath
    throw new Error('No system Node.js runtime found for GptWeb sidecar')
  }

  const candidates = dedupe([
    process.env.GATEWAYHUB_GPT_WEB_NODE_PATH,
    process.env.GATEWAYHUB_NODE_PATH,
    process.env.npm_node_execpath,
    process.env.NODE,
    ...pathNodeCandidates(),
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node'
  ])

  for (const candidate of candidates) {
    if (!candidate) continue
    if (isUsableSystemNode(candidate)) {
      cachedNodePath = candidate
      return candidate
    }
  }

  cachedNodePath = null
  throw new Error(
    'GptWeb upstream is blocked from Electron runtime and requires a system Node.js sidecar. Set GATEWAYHUB_GPT_WEB_NODE_PATH to a Node.js executable.'
  )
}

function resolveCliEntryPath(): string {
  if (cachedCliPath !== undefined) {
    if (cachedCliPath) return cachedCliPath
    throw new Error('GatewayHub CLI entry not found for GptWeb sidecar')
  }

  const candidates = dedupe([
    process.env.GATEWAYHUB_CLI_PATH,
    join(process.resourcesPath || '', 'cli', 'gatewayhub.js'),
    resolve(__dirname, '../cli.js'),
    resolve(__dirname, 'cli.js'),
    resolve(process.cwd(), 'out/main/cli.js'),
    join(process.resourcesPath || '', 'app.asar.unpacked', 'out', 'main', 'cli.js'),
    join(process.resourcesPath || '', 'app', 'out', 'main', 'cli.js')
  ])

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      cachedCliPath = candidate
      return candidate
    }
  }

  cachedCliPath = null
  throw new Error('GatewayHub CLI entry not found for GptWeb sidecar')
}

function isUsableSystemNode(candidate: string): boolean {
  try {
    if (candidate === process.execPath && shouldUseNodeBridge()) return false
    const output = execFileSync(
      candidate,
      [
        '-e',
        'if (process.versions.electron) process.exit(42); const major=Number(process.versions.node.split(".")[0]); process.exit(major >= 20 ? 0 : 43)'
      ],
      { timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    return output !== undefined
  } catch {
    return false
  }
}

function pathNodeCandidates(): string[] {
  return (process.env.PATH || '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, process.platform === 'win32' ? 'node.exe' : 'node'))
}

function dedupe(items: Array<string | undefined>): string[] {
  return [...new Set(items.filter((item): item is string => Boolean(item)))]
}
