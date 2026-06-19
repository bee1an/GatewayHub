import type { QoderAccountConfig } from '../../types'
import { sha256Short } from '../../core/utils'

export function buildQoderAccountFromInput(input: any): QoderAccountConfig | null {
  if (!input || typeof input !== 'object') return null
  const personalAccessToken = pickString(input, [
    'personalAccessToken',
    'personal_access_token',
    'qoderPersonalAccessToken',
    'qoder_personal_access_token',
    'pat',
    'token',
    'apiKey',
    'api_key',
    'key',
    'QODER_PERSONAL_ACCESS_TOKEN'
  ])
  if (!personalAccessToken && wantsCliAuth(input)) {
    return buildQoderCliAuthAccount(input)
  }
  if (!personalAccessToken) return null
  const email = normalizeEmail(pickString(input, ['email', 'userEmail', 'user_email']))
  const label =
    pickString(input, ['label', 'name']) || email || `Qoder ${sha256Short(personalAccessToken, 6)}`
  return {
    id: pickString(input, ['id']) || `qoder-${sha256Short(personalAccessToken)}`,
    label,
    email,
    enabled: input.enabled !== false,
    authType: 'qoder-personal-access-token',
    personalAccessToken,
    qoderCliPath: pickString(input, ['qoderCliPath', 'qoder_cli_path', 'cliPath', 'cli_path'])
  }
}

export function buildQoderCliAuthAccount(input: any = {}): QoderAccountConfig | null {
  const qoderCliHome = pickString(input, [
    'qoderCliHome',
    'qoder_cli_home',
    'cliHome',
    'cli_home',
    'QODER_CLI_HOME'
  ])
  if (!qoderCliHome) return null
  const qoderCliPath = pickString(input, ['qoderCliPath', 'qoder_cli_path', 'cliPath', 'cli_path'])
  const email = normalizeEmail(pickString(input, ['email', 'userEmail', 'user_email']))
  const label = pickString(input, ['label', 'name']) || email || 'Qoder CLI Login'
  return {
    id: pickString(input, ['id']) || `qoder-cli-${sha256Short(qoderCliHome)}`,
    label,
    email,
    enabled: input.enabled !== false,
    authType: 'qoder-cli-auth',
    qoderCliHome,
    qoderCliPath
  }
}

/** @deprecated Use buildQoderCliAuthAccount with a managed qoderCliHome. */
export function buildQoderCliLoginAccount(input: any = {}): QoderAccountConfig | null {
  return buildQoderCliAuthAccount(input)
}

export function parseQoderAuthInput(text: string): QoderAccountConfig[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (!looksLikeJson(trimmed)) {
    const account = buildQoderAccountFromInput({ personalAccessToken: trimmed })
    return account ? [account] : []
  }
  const parsed = JSON.parse(trimmed)
  const items = Array.isArray(parsed)
    ? parsed
    : parsed.accounts && Array.isArray(parsed.accounts)
      ? parsed.accounts
      : [parsed]
  return items
    .map(buildQoderAccountFromInput)
    .filter((item): item is QoderAccountConfig => Boolean(item))
}

function pickString(input: Record<string, any>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function wantsCliAuth(input: Record<string, any>): boolean {
  if (input.cliLogin === true || input.useCliLogin === true || input.useQoderCliLogin === true) {
    return true
  }
  const authType = pickString(input, ['authType', 'auth_type', 'type', 'auth'])
    ?.toLowerCase()
    .replace(/_/g, '-')
  return (
    authType === 'qoder-cli-auth' ||
    authType === 'qoder-cli-login' ||
    authType === 'cli-login' ||
    authType === 'qodercli'
  )
}

function looksLikeJson(value: string): boolean {
  return value.startsWith('{') || value.startsWith('[')
}

function normalizeEmail(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : undefined
}
