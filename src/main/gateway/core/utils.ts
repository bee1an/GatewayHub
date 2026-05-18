import { createHash, randomBytes, randomUUID } from 'crypto'
import { homedir, hostname, userInfo } from 'os'
import { dirname, join } from 'path'
import { mkdir, readFile, stat, writeFile } from 'fs/promises'

export function generateApiKey(): string {
  return `ghub-${randomBytes(24).toString('base64url')}`
}

export function requestId(prefix = 'req'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`
}

export function sha256Short(input: string, length = 16): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length)
}

export function expandHome(input: string): string {
  if (!input) return input
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return join(homedir(), input.slice(2))
  return input
}

export async function isDirectory(input: string): Promise<boolean> {
  try {
    return (await stat(expandHome(input))).isDirectory()
  } catch {
    return false
  }
}

export async function readJsonFile<T = any>(path: string): Promise<T> {
  const content = await readFile(expandHome(path), 'utf8')
  return JSON.parse(content) as T
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  const finalPath = expandHome(path)
  await mkdir(dirname(finalPath), { recursive: true })
  await writeFile(finalPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export function parseIsoDate(value?: string): Date | undefined {
  if (!value) return undefined
  const normalized = value.endsWith('Z') ? value.replace('Z', '+00:00') : value
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? undefined : date
}

export function machineFingerprint(): string {
  try {
    const who = userInfo().username
    return createHash('sha256').update(`${hostname()}-${who}-gatewayhub`).digest('hex')
  } catch {
    return createHash('sha256').update('gatewayhub').digest('hex')
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export async function parseRequestBody(
  req: NodeJS.ReadableStream,
  maxBytes = 25 * 1024 * 1024
): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buf.length
    if (size > maxBytes) throw new Error('Request body too large')
    chunks.push(buf)
  }
  if (!chunks.length) return undefined
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return undefined
  return JSON.parse(text)
}

export function jsonResponse(status: number, body: unknown, headers?: Record<string, string>) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(headers ?? {}) },
    body
  }
}

export function sseData(value: unknown): string {
  return `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
}

export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return Math.max(1, Math.ceil(text.length / 4))
}
