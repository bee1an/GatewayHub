import type { NvidiaAccountConfig } from '../../types'
import { sha256Short } from '../../core/utils'

export function buildNvidiaAccountFromInput(input: any): NvidiaAccountConfig | null {
  if (!input || typeof input !== 'object') return null
  const apiKey = pickString(input, ['apiKey', 'api_key', 'key', 'token'])
  if (!apiKey) return null
  const label = pickString(input, ['label', 'name']) || `NVIDIA ${sha256Short(apiKey, 6)}`
  return {
    id: pickString(input, ['id']) || `nvidia-${sha256Short(apiKey)}`,
    label,
    enabled: input.enabled !== false,
    apiKey
  }
}

export function parseNvidiaAuthInput(text: string): NvidiaAccountConfig[] {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    const account = buildNvidiaAccountFromInput({ apiKey: trimmed })
    return account ? [account] : []
  }
  const parsed = JSON.parse(trimmed)
  const items = Array.isArray(parsed)
    ? parsed
    : parsed.accounts && Array.isArray(parsed.accounts)
      ? parsed.accounts
      : [parsed]
  return items
    .map(buildNvidiaAccountFromInput)
    .filter((item): item is NvidiaAccountConfig => Boolean(item))
}

function pickString(input: Record<string, any>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}
