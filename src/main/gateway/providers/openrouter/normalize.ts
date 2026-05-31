import type { OpenRouterAccountConfig } from '../../types'
import { sha256Short } from '../../core/utils'

export function buildOpenRouterAccountFromInput(input: any): OpenRouterAccountConfig | null {
  if (!input || typeof input !== 'object') return null
  const apiKey = pickString(input, ['apiKey', 'api_key', 'key', 'token'])
  if (!apiKey) return null
  const label = pickString(input, ['label', 'name']) || `OpenRouter ${sha256Short(apiKey, 6)}`
  return {
    id: pickString(input, ['id']) || `openrouter-${sha256Short(apiKey)}`,
    label,
    enabled: input.enabled !== false,
    apiKey
  }
}

export function parseOpenRouterAuthInput(text: string): OpenRouterAccountConfig[] {
  const trimmed = text.trim()
  if (trimmed.startsWith('sk-or-')) {
    const account = buildOpenRouterAccountFromInput({ apiKey: trimmed })
    return account ? [account] : []
  }
  const parsed = JSON.parse(trimmed)
  const items = Array.isArray(parsed)
    ? parsed
    : parsed.accounts && Array.isArray(parsed.accounts)
      ? parsed.accounts
      : [parsed]
  return items
    .map(buildOpenRouterAccountFromInput)
    .filter((item): item is OpenRouterAccountConfig => Boolean(item))
}

function pickString(input: Record<string, any>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}
