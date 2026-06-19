import { spawn, type ChildProcessByStdio } from 'child_process'
import type { Readable } from 'stream'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import type { QoderAccountConfig, QoderProviderSettings } from '../../types'
import { toErrorMessage } from '../../core/utils'
import { normalizeQoderMaxOutputTokens, normalizeQoderModel } from './constants'

export type QoderCliTextEvent = {
  text: string
  finishReason?: string
  raw?: unknown
}

export class QoderCliError extends Error {
  readonly code?: string
  readonly stderr?: string
  readonly exitCode?: number | null
  readonly signal?: NodeJS.Signals | null

  constructor(
    message: string,
    options?: {
      code?: string
      stderr?: string
      exitCode?: number | null
      signal?: NodeJS.Signals | null
    }
  ) {
    super(message)
    this.name = 'QoderCliError'
    this.code = options?.code
    this.stderr = options?.stderr
    this.exitCode = options?.exitCode
    this.signal = options?.signal
  }
}

export async function checkQoderCliAvailable(
  account: QoderAccountConfig | undefined,
  settings: QoderProviderSettings
): Promise<{ ok: boolean; message: string; version?: string }> {
  try {
    const result = await runQoderCliCommand(['--version'], account, settings, 8_000)
    const version = `${result.stdout || result.stderr}`.trim().split(/\r?\n/)[0]
    return { ok: true, message: version || 'qodercli is available', version }
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return {
        ok: false,
        message: `qodercli not found: ${resolveQoderCliCommand(account, settings).cmd}`
      }
    }
    return { ok: false, message: toErrorMessage(error) }
  }
}

export async function listQoderCliModels(
  account: QoderAccountConfig,
  settings: QoderProviderSettings,
  knownModels: string[]
): Promise<string[]> {
  const result = await runQoderCliCommand(['--list-models'], account, settings, 15_000)
  const text = `${result.stdout}\n${result.stderr}`
  const parsed = parseModelList(text, knownModels)
  return parsed.length ? parsed : knownModels
}

export async function* streamQoderCliRequest(options: {
  account: QoderAccountConfig
  settings: QoderProviderSettings
  prompt: string
  model: string
  maxTokens?: number
  signal?: AbortSignal
}): AsyncGenerator<QoderCliTextEvent> {
  const { account, settings, prompt, model, maxTokens, signal } = options
  const flags = buildRequestFlags(settings, maxTokens)
  const child = spawnQoderCli(
    [
      '-p',
      prompt,
      '-f',
      'stream-json',
      '--model',
      model,
      '--permission-mode',
      'bypass_permissions',
      ...flags
    ],
    account,
    settings
  )

  let stdoutBuffer = ''
  let stderr = ''
  let sawAssistantText = false
  let lastSyntheticText = ''
  let done = false
  let closeCode: number | null = null
  let closeSignal: NodeJS.Signals | null = null
  let spawnError: unknown
  let abortedBySignal = false
  let firstEventSeen = false
  let waitResolve: (() => void) | undefined
  const queue: QoderCliTextEvent[] = []

  const notify = (): void => {
    const resolve = waitResolve
    waitResolve = undefined
    resolve?.()
  }
  const push = (event: QoderCliTextEvent): void => {
    if (!event.text && !event.finishReason) return
    if (event.text) {
      firstEventSeen = true
      sawAssistantText = true
    }
    queue.push(event)
    notify()
  }

  const cleanupTimers: Array<() => void> = []
  const firstTimeoutMs = secondsToMs(settings.firstTokenTimeoutSeconds, 120_000)
  const readTimeoutMs = secondsToMs(settings.streamingReadTimeoutSeconds, 300_000)
  let idleTimer: NodeJS.Timeout | undefined

  const resetIdleTimer = (phase: 'first' | 'read'): void => {
    if (idleTimer) clearTimeout(idleTimer)
    const timeoutMs = phase === 'first' ? firstTimeoutMs : readTimeoutMs
    if (timeoutMs <= 0) return
    idleTimer = setTimeout(() => {
      killChild(child)
      spawnError = new QoderCliError(
        phase === 'first'
          ? `qodercli timed out before first token after ${timeoutMs}ms`
          : `qodercli stream idle timeout after ${timeoutMs}ms`,
        { code: 'TIMEOUT', stderr }
      )
      done = true
      notify()
    }, timeoutMs)
    if (typeof idleTimer.unref === 'function') idleTimer.unref()
  }
  resetIdleTimer('first')
  cleanupTimers.push(() => {
    if (idleTimer) clearTimeout(idleTimer)
  })

  const onAbort = (): void => {
    abortedBySignal = true
    killChild(child)
    done = true
    notify()
  }
  if (signal) {
    if (signal.aborted) onAbort()
    else {
      signal.addEventListener('abort', onAbort, { once: true })
      cleanupTimers.push(() => signal.removeEventListener('abort', onAbort))
    }
  }

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString()
    const lines = stdoutBuffer.split(/\r?\n/)
    stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      processQoderLine(
        line,
        push,
        () => sawAssistantText,
        (v) => (lastSyntheticText = v),
        () => lastSyntheticText
      )
      if (firstEventSeen) resetIdleTimer('read')
    }
  })

  child.stdout.on('end', () => {
    const line = stdoutBuffer.trim()
    stdoutBuffer = ''
    if (line) {
      processQoderLine(
        line,
        push,
        () => sawAssistantText,
        (v) => (lastSyntheticText = v),
        () => lastSyntheticText
      )
    }
  })

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString()
    stderr += text
  })

  child.on('error', (error) => {
    spawnError = error
    done = true
    notify()
  })

  child.on('close', (code, signal) => {
    closeCode = code
    closeSignal = signal
    done = true
    notify()
  })

  try {
    while (!done || queue.length) {
      if (queue.length) {
        const event = queue.shift()!
        yield event
        continue
      }
      await new Promise<void>((resolve) => {
        waitResolve = resolve
      })
    }

    if (abortedBySignal) {
      throw new QoderCliError('Client aborted request', { code: 'ABORTED', stderr })
    }
    if (spawnError) {
      if (spawnError instanceof QoderCliError) throw spawnError
      const error = spawnError as NodeJS.ErrnoException
      throw new QoderCliError(error.message || toErrorMessage(error), {
        code: error.code,
        stderr
      })
    }
    if (closeCode && closeCode !== 0) {
      throw new QoderCliError(
        `qodercli exited with code ${closeCode}${stderr.trim() ? `: ${stderr.trim().slice(0, 600)}` : ''}`,
        { code: 'EXIT_NON_ZERO', stderr, exitCode: closeCode, signal: closeSignal }
      )
    }
  } finally {
    cleanupTimers.forEach((fn) => fn())
    if (!done) killChild(child)
  }
}

function processQoderLine(
  line: string,
  push: (event: QoderCliTextEvent) => void,
  sawAssistantText: () => boolean,
  setLastSyntheticText: (value: string) => void,
  getLastSyntheticText: () => string
): void {
  const trimmed = line.trim()
  if (!trimmed) return
  try {
    const data = JSON.parse(trimmed)
    if (isAssistantMessageEvent(data)) {
      push({
        text: extractTextContent(data.message),
        finishReason: data.message?.stop_reason,
        raw: data
      })
      return
    }
    const fallback = extractEventText(data)
    if (!fallback || sawAssistantText()) return
    if (fallback === getLastSyntheticText()) return
    setLastSyntheticText(fallback)
    push({ text: fallback, raw: data })
  } catch {
    if (!trimmed.startsWith('{')) push({ text: trimmed })
  }
}

function isAssistantMessageEvent(data: any): boolean {
  return (
    data?.type === 'assistant' &&
    (data?.subtype === 'message' || data?.message?.type === 'message' || data?.message?.content)
  )
}

export function extractTextContent(message: any): string {
  if (!message) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) return ''
        if (typeof part === 'string') return part
        if (typeof part.text === 'string') return part.text
        if (typeof part.value === 'string') return part.value
        if (typeof part?.text?.value === 'string') return part.text.value
        return ''
      })
      .join('')
  }
  return ''
}

function extractEventText(data: any): string {
  const fromMessage = extractTextContent(data?.message)
  if (fromMessage.trim()) return fromMessage
  if (typeof data?.result === 'string' && data.result.trim()) return data.result
  return deepFindText(data)
}

function deepFindText(value: unknown, depth = 0): string {
  if (depth > 6 || value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = deepFindText(item, depth + 1)
      if (text) return text
    }
    return ''
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of [
      'text',
      'value',
      'result',
      'output',
      'content',
      'message',
      'final',
      'answer'
    ]) {
      if (Object.prototype.hasOwnProperty.call(record, key)) {
        const text = deepFindText(record[key], depth + 1)
        if (text) return text
      }
    }
  }
  return ''
}

function buildRequestFlags(
  settings: QoderProviderSettings,
  maxTokens: number | undefined
): string[] {
  const flags: string[] = []
  if (maxTokens !== undefined && Number.isFinite(maxTokens)) {
    if (maxTokens >= 32_000) flags.push('--max-output-tokens', '32k')
    else if (maxTokens >= 16_000) flags.push('--max-output-tokens', '16k')
  }
  if (!flags.length)
    flags.push('--max-output-tokens', normalizeQoderMaxOutputTokens(settings.maxOutputTokens))
  return flags
}

function runQoderCliCommand(
  args: string[],
  account: QoderAccountConfig | undefined,
  settings: QoderProviderSettings,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawnQoderCli(args, account, settings)
    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      killChild(child)
      settle(() =>
        reject(
          new QoderCliError(`qodercli timed out after ${timeoutMs}ms`, { code: 'TIMEOUT', stderr })
        )
      )
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()))
    child.on('error', (error: NodeJS.ErrnoException) => {
      settle(() => reject(error))
    })
    child.on('close', (code) => {
      settle(() => {
        if (code && code !== 0) {
          reject(
            new QoderCliError(
              `qodercli exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 600)}` : ''}`,
              { code: 'EXIT_NON_ZERO', stderr, exitCode: code }
            )
          )
          return
        }
        resolve({ stdout, stderr, code })
      })
    })
  })
}

type QoderChildProcess = ChildProcessByStdio<null, Readable, Readable>

function spawnQoderCli(
  args: string[],
  account: QoderAccountConfig | undefined,
  settings: QoderProviderSettings
): QoderChildProcess {
  const command = resolveQoderCliCommand(account, settings)
  const env = buildQoderEnv(account, settings)
  if (process.platform === 'win32' && command.viaCmd) {
    return spawn('cmd.exe', ['/c', command.cmd, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env
    })
  }
  return spawn(command.cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
}

function resolveQoderCliCommand(
  account: QoderAccountConfig | undefined,
  settings: QoderProviderSettings
): { cmd: string; viaCmd: boolean } {
  const explicit = account?.qoderCliPath || settings.qoderCliPath || process.env.QODERCLI_BIN
  if (explicit?.trim()) return { cmd: explicit.trim(), viaCmd: false }
  if (process.platform === 'win32') return { cmd: 'qodercli.cmd', viaCmd: true }
  const home = process.env.HOME || process.env.USERPROFILE || ''
  for (const candidate of [
    home ? `${home}/.local/bin/qodercli` : '',
    '/usr/local/bin/qodercli',
    '/opt/homebrew/bin/qodercli',
    '/usr/bin/qodercli'
  ]) {
    if (existsSync(candidate)) return { cmd: candidate, viaCmd: false }
  }
  return { cmd: 'qodercli', viaCmd: false }
}

function buildQoderEnv(
  account: QoderAccountConfig | undefined,
  settings: QoderProviderSettings
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NO_BROWSER: '1',
    CI: '1',
    HOME: process.env.HOME || process.env.USERPROFILE || '/tmp'
  }
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy'
  ]) {
    delete env[key]
  }
  if (account?.personalAccessToken) {
    env.QODER_PERSONAL_ACCESS_TOKEN = account.personalAccessToken
  } else {
    delete env.QODER_PERSONAL_ACCESS_TOKEN
  }
  if (!account?.personalAccessToken && account?.qoderCliHome?.trim()) {
    env.QODER_CLI_HOME = account.qoderCliHome.trim()
  } else {
    delete env.QODER_CLI_HOME
  }
  const proxy = settings.vpnProxyUrl?.trim()
  if (proxy) {
    env.HTTP_PROXY = proxy
    env.HTTPS_PROXY = proxy
    env.ALL_PROXY = proxy
    env.http_proxy = proxy
    env.https_proxy = proxy
    env.all_proxy = proxy
  }
  return env
}

function parseModelList(text: string, knownModels: string[]): string[] {
  const found = new Set<string>()
  const known = new Set(knownModels)
  const tokens = text
    .split(/[^a-zA-Z0-9_.:/-]+/)
    .map((token) => token.trim())
    .filter(Boolean)
  for (const token of tokens) {
    const normalized = token.replace(/^--?/, '')
    for (const candidate of [
      normalized,
      normalized.toLowerCase(),
      normalizeQoderModel(normalized),
      normalizeQoderModel(normalized.toLowerCase())
    ]) {
      if (known.has(candidate)) found.add(candidate)
    }
  }
  return [...found]
}

function secondsToMs(value: unknown, fallbackMs: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallbackMs
  return Math.max(1_000, Math.trunc(n * 1000))
}

function killChild(child: QoderChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }
    }, 1_000).unref?.()
  } catch {
    /* ignore */
  }
}

export function qoderCompletionId(prefix = 'chatcmpl'): string {
  return `${prefix}-${randomUUID().replace(/-/g, '')}`
}
