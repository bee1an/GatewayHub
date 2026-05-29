import type { WindsurfAccountConfig } from '../../types'
import { sha256Short } from '../../core/utils'

export function buildWindsurfAccountFromInput(input: any): WindsurfAccountConfig | null {
  if (!input || typeof input !== 'object') return null
  const apiKey = pickString(input, ['apiKey', 'api_key', 'accessToken', 'access_token', 'token'])
  if (!apiKey) return null
  const email = normalizeEmail(pickString(input, ['email', 'userEmail', 'user_email']))
  const label =
    pickString(input, ['label', 'name']) ||
    input.account?.label ||
    input.account?.id ||
    email ||
    `Windsurf ${sha256Short(apiKey, 6)}`
  return {
    id: pickString(input, ['id']) || `windsurf-${sha256Short(apiKey)}`,
    label,
    email,
    enabled: input.enabled !== false,
    apiKey,
    apiServerUrl: pickString(input, ['apiServerUrl', 'api_server_url']) || undefined,
    inferenceApiServerUrl:
      pickString(input, ['inferenceApiServerUrl', 'inference_api_server_url']) || undefined,
    authType: pickString(input, ['authType', 'auth_type']) || 'windsurf-api-key'
  }
}

export function parseWindsurfAuthInput(text: string): WindsurfAccountConfig[] {
  const parsed = JSON.parse(text.trim())
  const items = Array.isArray(parsed)
    ? parsed
    : parsed.accounts && Array.isArray(parsed.accounts)
      ? parsed.accounts
      : [parsed]
  return items
    .map(buildWindsurfAccountFromInput)
    .filter((item): item is WindsurfAccountConfig => Boolean(item))
}

function pickString(input: Record<string, any>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : undefined
}
