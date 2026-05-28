import { dirname, join } from 'path'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises'
import { homedir } from 'os'
import type {
  ApiKeyEntry,
  CodexAccountConfig,
  GatewayHubConfig,
  GatewayHubState,
  KiroAccountConfig,
  ModelMapping
} from './types'
import {
  DEFAULT_KIRO_SETTINGS,
  SQLITE_TOKEN_KEYS,
  SQLITE_REGISTRATION_KEYS,
  normalizeKiroModelId
} from './providers/kiro/constants'
import { DEFAULT_CODEX_SETTINGS } from './providers/codex/constants'
import { buildCodexAccountFromAuth } from './providers/codex/normalize'
import type { CodexAuthPayload } from './providers/codex/types'
import { generateApiKey, readJsonFile, sha256Short, writeJsonFile, atomicWrite } from './core/utils'
import { getPaths } from './core/paths'

export class GatewayConfigStore {
  readonly configPath: string
  readonly statePath: string

  constructor() {
    const home = getPaths().home()
    const configDir = join(home, '.config', 'gatewayhub')
    this.configPath = join(configDir, 'gatewayhub.config.json')
    this.statePath = join(configDir, 'gatewayhub.state.json')
  }

  accountsDir(): string {
    return join(dirname(this.configPath), 'kiro', 'accounts')
  }

  codexAccountsDir(): string {
    return join(dirname(this.configPath), 'codex', 'accounts')
  }

  logsDir(): string {
    return join(dirname(this.configPath), 'logs')
  }

  async migrateIfNeeded(): Promise<void> {
    const configDir = dirname(this.configPath)
    await mkdir(configDir, { recursive: true })

    const configExists = await stat(this.configPath).then(
      () => true,
      () => false
    )
    if (configExists) return

    const oldDir = getPaths().userData()
    const oldConfigPath = join(oldDir, 'gatewayhub.config.json')
    const oldStatePath = join(oldDir, 'gatewayhub.state.json')

    try {
      const oldConfig = await readFile(oldConfigPath, 'utf8')
      await writeFile(this.configPath, oldConfig, 'utf8')
    } catch {
      /* no old config */
    }

    try {
      const oldState = await readFile(oldStatePath, 'utf8')
      await writeFile(this.statePath, oldState, 'utf8')
    } catch {
      /* no old state */
    }
  }

  async loadConfig(): Promise<GatewayHubConfig> {
    let raw: string
    try {
      raw = await readFile(this.configPath, 'utf8')
    } catch {
      const config = this.defaultConfig()
      await this.saveConfig(config)
      return config
    }

    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch {
      console.warn(
        `[GatewayHub] Config file is corrupt, renaming to broken backup: ${this.configPath}`
      )
      const brokenPath = `${this.configPath}.broken-${Date.now()}.json`
      await rename(this.configPath, brokenPath).catch(() => {})
      const config = this.defaultConfig()
      await this.saveConfig(config)
      return config
    }

    if ((parsed.version ?? 1) < 2) {
      await this.migrateAccountsToFiles(parsed)
    }

    // v2 → v3: codex 从 placeholder 升级为正式 provider，旧配置可能遗留 enabled=false，自动开启
    let migratedFromV2 = false
    if ((parsed.version ?? 1) < 3) {
      if (parsed.providers?.codex) {
        parsed.providers.codex.enabled = true
      }
      parsed.version = 3
      migratedFromV2 = true
    }

    const config = this.normalizeConfig(parsed)
    const shouldSaveNormalizedConfig =
      migratedFromV2 ||
      Boolean(parsed.providers?.kiro?.accounts) ||
      JSON.stringify(parsed.modelMappings ?? []) !== JSON.stringify(config.modelMappings)

    if (shouldSaveNormalizedConfig) {
      await this.saveConfig(config)
    }

    return config
  }

  async saveConfig(config: GatewayHubConfig): Promise<void> {
    const clone = JSON.parse(JSON.stringify(config))
    delete (clone.providers?.kiro as any)?.accounts
    await mkdir(dirname(this.configPath), { recursive: true })
    await atomicWrite(this.configPath, `${JSON.stringify(clone, null, 2)}\n`)
  }

  async loadState(): Promise<GatewayHubState> {
    try {
      const raw = await readFile(this.statePath, 'utf8')
      return this.normalizeState(JSON.parse(raw))
    } catch {
      const state = this.defaultState()
      await this.saveState(state)
      return state
    }
  }

  async saveState(state: GatewayHubState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true })
    await atomicWrite(this.statePath, `${JSON.stringify(state, null, 2)}\n`)
  }

  async readAccountFiles(): Promise<KiroAccountConfig[]> {
    const dir = this.accountsDir()
    let files: string[]
    try {
      files = await readdir(dir)
    } catch {
      return []
    }

    const accounts: KiroAccountConfig[] = []
    for (const file of files) {
      if (!file.endsWith('.json') || file.startsWith('.')) continue
      const filePath = join(dir, file)
      try {
        const data = await readJsonFile<any>(filePath)
        if (!data.id) data.id = makeStableId(data)
        if (data.enabled === undefined) data.enabled = true
        data.path = filePath
        accounts.push(data as KiroAccountConfig)
      } catch (err) {
        console.warn(`[GatewayHub] Skipping corrupt account file: ${file}`, err)
      }
    }
    return accounts
  }

  async writeAccountFile(data: KiroAccountConfig): Promise<string> {
    const dir = this.accountsDir()
    await mkdir(dir, { recursive: true })

    const fileBase = safeFileName(data.email || data.label || data.id) || 'account'
    const targetPath = join(dir, `${fileBase}.json`)

    const existing = await readJsonFile<any>(targetPath).catch(() => null)
    if (existing && existing.id && existing.id !== data.id) {
      const altPath = join(dir, `${fileBase}-${sha256Short(data.id)}.json`)
      await atomicWrite(altPath, `${JSON.stringify(stripPath(data), null, 2)}\n`)
      return altPath
    }

    await atomicWrite(targetPath, `${JSON.stringify(stripPath(data), null, 2)}\n`)
    return targetPath
  }

  async deleteAccountFile(accountId: string): Promise<boolean> {
    const accounts = await this.readAccountFiles()
    const account = accounts.find((a) => a.id === accountId)
    if (!account?.path) return false
    await unlink(account.path)
    return true
  }

  async updateAccountFile(accountId: string, updates: Partial<KiroAccountConfig>): Promise<void> {
    const accounts = await this.readAccountFiles()
    const account = accounts.find((a) => a.id === accountId)
    if (!account?.path) throw new Error(`Account not found: ${accountId}`)
    const data = await readJsonFile<any>(account.path)
    Object.assign(data, updates)
    await atomicWrite(account.path, `${JSON.stringify(data, null, 2)}\n`)

    if (updates.email && updates.email !== account.email) {
      const dir = dirname(account.path)
      const newBase = safeFileName(updates.email)
      if (newBase) {
        const newPath = join(dir, `${newBase}.json`)
        const conflict = await readJsonFile<any>(newPath).catch(() => null)
        if (!conflict || conflict.id === accountId) {
          await rename(account.path, newPath).catch(() => {})
        }
      }
    }
  }

  async scanExternalAccounts(): Promise<Array<KiroAccountConfig & { sourceType: string }>> {
    const candidates: Array<KiroAccountConfig & { sourceType: string }> = []
    const home = getPaths().home()

    const kiroJson = join(home, '.aws', 'sso', 'cache', 'kiro-auth-token.json')
    const kiroJsonAccount = await extractAccountFromJson(kiroJson, 'Kiro IDE credentials')
    if (kiroJsonAccount) candidates.push(kiroJsonAccount)

    const ssoCache = join(home, '.aws', 'sso', 'cache')
    try {
      const files = await readdir(ssoCache)
      for (const file of files) {
        if (!file.endsWith('.json') || file === 'kiro-auth-token.json') continue
        const full = join(ssoCache, file)
        const account = await extractAccountFromJson(full, `AWS SSO cache ${file}`)
        if (account) candidates.push(account)
      }
    } catch {
      /* ignore missing directory */
    }

    for (const dbPath of [
      join(home, '.local', 'share', 'kiro-cli', 'data.sqlite3'),
      join(home, '.local', 'share', 'amazon-q', 'data.sqlite3')
    ]) {
      const account = await extractAccountFromSqlite(dbPath)
      if (account) candidates.push(account)
    }

    return candidates
  }

  async scanKiroAccounts(): Promise<{
    candidates: Array<KiroAccountConfig & { existing?: boolean; sourceType?: string }>
  }> {
    const external = await this.scanExternalAccounts()
    const existing = await this.readAccountFiles()
    const existingKeys = new Set<string>()
    for (const acc of existing) {
      for (const k of accountIdentityKeys(acc)) existingKeys.add(k)
    }

    const result: Array<KiroAccountConfig & { existing?: boolean; sourceType?: string }> = []
    for (const candidate of external) {
      const keys = accountIdentityKeys(candidate)
      const isExisting = keys.some((k) => existingKeys.has(k))
      result.push({ ...candidate, existing: isExisting || undefined })
    }
    return { candidates: result }
  }

  // ============== Codex account file management ==============

  async readCodexAccountFiles(): Promise<CodexAccountConfig[]> {
    const dir = this.codexAccountsDir()
    let files: string[]
    try {
      files = await readdir(dir)
    } catch {
      return []
    }
    const accounts: CodexAccountConfig[] = []
    for (const file of files) {
      if (!file.endsWith('.json') || file.startsWith('.')) continue
      const filePath = join(dir, file)
      try {
        const data = await readJsonFile<any>(filePath)
        if (data.enabled === undefined) data.enabled = true
        data.path = filePath
        accounts.push(data as CodexAccountConfig)
      } catch (err) {
        console.warn(`[GatewayHub] Skipping corrupt codex account file: ${file}`, err)
      }
    }
    return accounts
  }

  async writeCodexAccountFile(data: CodexAccountConfig): Promise<string> {
    const dir = this.codexAccountsDir()
    await mkdir(dir, { recursive: true })
    const fileBase = safeFileName(data.email || data.label || data.id) || 'account'
    const targetPath = join(dir, `${fileBase}.json`)
    const existing = await readJsonFile<any>(targetPath).catch(() => null)
    if (existing && existing.id && existing.id !== data.id) {
      const altPath = join(dir, `${fileBase}-${sha256Short(data.id)}.json`)
      await atomicWrite(altPath, `${JSON.stringify(stripCodexPath(data), null, 2)}\n`)
      return altPath
    }
    await atomicWrite(targetPath, `${JSON.stringify(stripCodexPath(data), null, 2)}\n`)
    return targetPath
  }

  async deleteCodexAccountFile(accountId: string): Promise<boolean> {
    const accounts = await this.readCodexAccountFiles()
    const account = accounts.find((a) => a.id === accountId)
    if (!account?.path) return false
    await unlink(account.path)
    return true
  }

  async updateCodexAccountFile(
    accountId: string,
    updates: Partial<CodexAccountConfig>
  ): Promise<void> {
    const accounts = await this.readCodexAccountFiles()
    const account = accounts.find((a) => a.id === accountId)
    if (!account?.path) throw new Error(`Codex account not found: ${accountId}`)
    const data = await readJsonFile<any>(account.path)
    Object.assign(data, updates)
    await atomicWrite(account.path, `${JSON.stringify(data, null, 2)}\n`)
    if (updates.email && updates.email !== account.email) {
      const dir = dirname(account.path)
      const newBase = safeFileName(updates.email)
      if (newBase) {
        const newPath = join(dir, `${newBase}.json`)
        const conflict = await readJsonFile<any>(newPath).catch(() => null)
        if (!conflict || conflict.id === accountId) {
          await rename(account.path, newPath).catch(() => {})
        }
      }
    }
  }

  /**
   * 扫描本机已有的 Codex 凭据：
   * 1. ~/.codex/auth.json — 官方 codex CLI 登录后的位置
   */
  async scanCodexAccounts(): Promise<{
    candidates: Array<CodexAccountConfig & { existing?: boolean; sourceType?: string }>
  }> {
    const external = await this.scanExternalCodexAccounts()
    const existing = await this.readCodexAccountFiles()
    const existingKeys = new Set<string>()
    for (const acc of existing) {
      for (const k of codexIdentityKeys(acc)) existingKeys.add(k)
    }
    const result: Array<CodexAccountConfig & { existing?: boolean; sourceType?: string }> = []
    for (const candidate of external) {
      const keys = codexIdentityKeys(candidate)
      const isExisting = keys.some((k) => existingKeys.has(k))
      result.push({ ...candidate, existing: isExisting || undefined })
    }
    return { candidates: result }
  }

  private async scanExternalCodexAccounts(): Promise<
    Array<CodexAccountConfig & { sourceType: string }>
  > {
    const candidates: Array<CodexAccountConfig & { sourceType: string }> = []
    const home = homedir()
    const codexAuth = join(home, '.codex', 'auth.json')
    try {
      const raw = await readFile(codexAuth, 'utf8')
      const parsed = JSON.parse(raw) as CodexAuthPayload
      const account = buildCodexAccountFromAuth(parsed)
      if (account) candidates.push({ ...account, sourceType: 'codex_cli' })
    } catch {
      /* ignore */
    }
    return candidates
  }

  defaultConfig(): GatewayHubConfig {
    return {
      version: 3,
      server: {
        host: '127.0.0.1',
        port: 9741,
        apiKeys: [generateApiKey()],
        autoStart: false
      },
      defaultProvider: 'kiro',
      providers: {
        kiro: {
          enabled: true,
          routeName: 'kiro',
          settings: { ...DEFAULT_KIRO_SETTINGS }
        },
        codex: {
          enabled: true,
          routeName: 'codex',
          settings: { ...DEFAULT_CODEX_SETTINGS }
        },
        gemini: {
          enabled: false,
          routeName: 'gemini',
          note: 'Reserved provider slot. Gemini account gateway is not implemented in v1.'
        }
      },
      modelMappings: []
    }
  }

  defaultState(): GatewayHubState {
    return {
      version: 1,
      providers: {
        kiro: {
          accounts: {},
          currentAccountIndex: 0,
          logs: []
        },
        codex: {
          accounts: {},
          currentAccountIndex: 0,
          logs: []
        }
      }
    }
  }

  private async migrateAccountsToFiles(config: any): Promise<void> {
    const accounts: any[] = config.providers?.kiro?.accounts
    if (!Array.isArray(accounts) || accounts.length === 0) {
      config.version = 2
      delete config.providers?.kiro?.accounts
      await this.saveConfig(config)
      return
    }

    const dir = this.accountsDir()
    await mkdir(dir, { recursive: true })

    for (const acc of accounts) {
      try {
        const accountData: KiroAccountConfig = {
          id: acc.id || makeStableId(acc),
          email: acc.email,
          label: acc.label,
          enabled: acc.enabled !== false,
          refreshToken: acc.refreshToken,
          accessToken: acc.accessToken,
          expiresAt: acc.expiresAt,
          profileArn: acc.profileArn,
          region: acc.region,
          apiRegion: acc.apiRegion
        }

        if ((acc.type === 'json' || acc.type === 'sqlite') && acc.path) {
          const sourceData = await readJsonFile<any>(acc.path).catch(() => null)
          if (sourceData) {
            accountData.refreshToken =
              accountData.refreshToken || sourceData.refreshToken || sourceData.refresh_token
            accountData.accessToken =
              accountData.accessToken || sourceData.accessToken || sourceData.access_token
            accountData.profileArn =
              accountData.profileArn || sourceData.profileArn || sourceData.profile_arn
            accountData.expiresAt =
              accountData.expiresAt || sourceData.expiresAt || sourceData.expires_at
            accountData.clientId = sourceData.clientId || sourceData.client_id
            accountData.clientSecret = sourceData.clientSecret || sourceData.client_secret
            if (sourceData.region && !accountData.region) accountData.region = sourceData.region
            if (!accountData.email) {
              accountData.email = normalizeEmail(sourceData.email || sourceData.userInfo?.email)
            }
          }

          if (acc.type === 'sqlite') {
            const sqlData = await extractAccountFromSqlite(acc.path)
            if (sqlData) {
              accountData.refreshToken = accountData.refreshToken || sqlData.refreshToken
              accountData.accessToken = accountData.accessToken || sqlData.accessToken
              accountData.profileArn = accountData.profileArn || sqlData.profileArn
              accountData.clientId = accountData.clientId || sqlData.clientId
              accountData.clientSecret = accountData.clientSecret || sqlData.clientSecret
              accountData.region = accountData.region || sqlData.region
            }
          }
        }

        if (acc.type === 'refresh_token' && !accountData.refreshToken) {
          accountData.refreshToken = acc.refreshToken
        }
        if (acc.type === 'access_token' && !accountData.accessToken) {
          accountData.accessToken = acc.accessToken
        }

        if (accountData.refreshToken || accountData.accessToken) {
          await this.writeAccountFile(accountData)
        }
      } catch {
        // skip accounts that fail to migrate
      }
    }

    config.version = 2
    delete config.providers.kiro.accounts
    await this.saveConfig(config)
  }

  private normalizeConfig(input: any): GatewayHubConfig {
    const defaults = this.defaultConfig()
    // 旧版本 codex 是 placeholder（含 note 字段），用 settings 合并时把它清掉
    const inputCodex = input?.providers?.codex
      ? { ...input.providers.codex, note: undefined }
      : undefined
    if (inputCodex) delete (inputCodex as any).note
    const config: GatewayHubConfig = {
      ...defaults,
      ...input,
      server: { ...defaults.server, ...(input?.server ?? {}) },
      providers: {
        ...defaults.providers,
        ...(input?.providers ?? {}),
        kiro: {
          ...defaults.providers.kiro,
          ...(input?.providers?.kiro ?? {}),
          routeName: input?.providers?.kiro?.routeName || defaults.providers.kiro.routeName,
          settings: {
            ...defaults.providers.kiro.settings,
            ...(input?.providers?.kiro?.settings ?? {})
          }
        },
        codex: {
          ...defaults.providers.codex,
          ...(inputCodex ?? {}),
          routeName: input?.providers?.codex?.routeName || defaults.providers.codex.routeName,
          enabled:
            typeof input?.providers?.codex?.enabled === 'boolean'
              ? input.providers.codex.enabled
              : defaults.providers.codex.enabled,
          settings: {
            ...defaults.providers.codex.settings,
            ...(input?.providers?.codex?.settings ?? {})
          }
        },
        gemini: {
          ...defaults.providers.gemini,
          ...(input?.providers?.gemini ?? {}),
          routeName: input?.providers?.gemini?.routeName || defaults.providers.gemini.routeName
        }
      }
    }
    config.version = input?.version ?? 1
    config.server.port = Number(config.server.port) || 9741
    config.server.host = config.server.host || '127.0.0.1'
    config.server.apiKeys = migrateApiKeys(input?.server)
    delete (config.server as any).apiKey
    config.defaultProvider = config.defaultProvider || 'kiro'
    config.modelMappings = sanitizeModelMappings(input?.modelMappings, kiroMappingProviders(config))
    delete (config.providers.kiro as any).accounts
    return config
  }

  private normalizeState(input: any): GatewayHubState {
    const defaults = this.defaultState()
    return {
      ...defaults,
      ...input,
      providers: {
        ...defaults.providers,
        ...(input?.providers ?? {}),
        kiro: {
          ...defaults.providers.kiro,
          ...(input?.providers?.kiro ?? {}),
          accounts: input?.providers?.kiro?.accounts ?? {},
          logs: Array.isArray(input?.providers?.kiro?.logs)
            ? input.providers.kiro.logs.slice(-1000)
            : []
        },
        codex: {
          ...defaults.providers.codex,
          ...(input?.providers?.codex ?? {}),
          accounts: input?.providers?.codex?.accounts ?? {},
          logs: Array.isArray(input?.providers?.codex?.logs)
            ? input.providers.codex.logs.slice(-1000)
            : []
        }
      }
    }
  }
}

export function makeStableId(account: Partial<KiroAccountConfig>): string {
  if (account.profileArn) return `kiro-profile-${sha256Short(account.profileArn)}`
  if (account.refreshToken) return `kiro-refresh-${sha256Short(account.refreshToken)}`
  if (account.accessToken) return `kiro-access-${sha256Short(account.accessToken)}`
  return `kiro-${sha256Short(Math.random().toString())}`
}

function accountIdentityKeys(account: Partial<KiroAccountConfig>): string[] {
  const keys: string[] = []
  if (account.profileArn) keys.push(`profile:${sha256Short(account.profileArn)}`)
  if (account.refreshToken) keys.push(`refresh:${sha256Short(account.refreshToken)}`)
  if (account.email) keys.push(`email:${account.email.toLowerCase()}`)
  if (!keys.length && account.accessToken) keys.push(`access:${sha256Short(account.accessToken)}`)
  return keys
}

function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : undefined
}

function safeFileName(value: unknown): string {
  return String(value ?? '').replace(/[^a-zA-Z0-9@._-]/g, '_')
}

function migrateApiKeys(serverInput: any): ApiKeyEntry[] {
  const raw = serverInput?.apiKeys
  if (Array.isArray(raw) && raw.length > 0) {
    if (typeof raw[0] === 'object' && raw[0].key) return raw as ApiKeyEntry[]
    return raw.map((k: string) => ({
      id: `key_${sha256Short(k, 12)}`,
      key: k,
      name: 'Default',
      createdAt: Date.now()
    }))
  }
  const legacy = serverInput?.apiKey
  if (typeof legacy === 'string' && legacy) {
    return [
      {
        id: `key_${sha256Short(legacy, 12)}`,
        key: legacy,
        name: 'Default',
        createdAt: Date.now()
      }
    ]
  }
  return [generateApiKey()]
}

function stripPath(data: KiroAccountConfig): Omit<KiroAccountConfig, 'path'> {
  const { path: _, ...rest } = data
  return rest
}

function stripCodexPath(data: CodexAccountConfig): Omit<CodexAccountConfig, 'path'> {
  const { path: _, ...rest } = data
  return rest
}

function codexIdentityKeys(account: Partial<CodexAccountConfig>): string[] {
  const keys: string[] = []
  if (account.chatgptAccountId) keys.push(`codex-acct:${account.chatgptAccountId}`)
  if (account.email) keys.push(`codex-email:${account.email.toLowerCase()}`)
  if (account.refreshToken) keys.push(`codex-refresh:${sha256Short(account.refreshToken)}`)
  if (!keys.length && account.accessToken)
    keys.push(`codex-access:${sha256Short(account.accessToken)}`)
  return keys
}

export function sanitizeModelMappings(
  input: unknown,
  kiroProviders: ReadonlySet<string> = new Set(['kiro'])
): ModelMapping[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const result: ModelMapping[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Partial<ModelMapping> & { provider?: unknown; model?: unknown }
    const alias = typeof item.alias === 'string' ? item.alias.trim() : ''
    const provider = typeof item.provider === 'string' ? item.provider.trim() : ''
    const rawModel = typeof item.model === 'string' ? item.model.trim() : ''
    if (!alias || !provider || !rawModel) continue
    const model = kiroProviders.has(provider) ? normalizeKiroModelId(rawModel) : rawModel
    if (/[\s/]/.test(alias)) continue
    if (alias.includes(':')) continue
    if (seen.has(alias)) continue
    seen.add(alias)
    const note = typeof item.note === 'string' ? item.note : undefined
    result.push({
      alias,
      provider,
      model,
      enabled: item.enabled !== false,
      ...(note ? { note } : {})
    })
  }
  return result
}

function kiroMappingProviders(config: GatewayHubConfig): Set<string> {
  const names = new Set<string>(['kiro'])
  const routeName = config.providers.kiro.routeName
  if (routeName) names.add(routeName)
  return names
}

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<any>

async function extractAccountFromJson(
  path: string,
  label: string
): Promise<(KiroAccountConfig & { sourceType: string }) | null> {
  try {
    const data = await readJsonFile<any>(path)
    const refreshToken = data.refreshToken || data.refresh_token
    const accessToken = data.accessToken || data.access_token
    if (!refreshToken && !accessToken) return null

    const profileArn = data.profileArn || data.profile_arn || ''
    const email = normalizeEmail(data.email || data.userInfo?.email)
    const id = profileArn
      ? `kiro-profile-${sha256Short(profileArn)}`
      : refreshToken
        ? `kiro-refresh-${sha256Short(refreshToken)}`
        : `kiro-access-${sha256Short(accessToken)}`

    return {
      id,
      email,
      label,
      enabled: true,
      refreshToken: refreshToken || undefined,
      accessToken: accessToken || undefined,
      profileArn: profileArn || undefined,
      clientId: data.clientId || data.client_id || undefined,
      clientSecret: data.clientSecret || data.client_secret || undefined,
      region: data.region || undefined,
      sourceType: 'json'
    }
  } catch {
    return null
  }
}

async function extractAccountFromSqlite(
  dbPath: string
): Promise<(KiroAccountConfig & { sourceType: string }) | null> {
  try {
    await stat(dbPath)
  } catch {
    return null
  }

  try {
    const sqlite = await dynamicImport('node:sqlite')
    const db = new sqlite.DatabaseSync(dbPath)
    try {
      let refreshToken = ''
      let accessToken = ''
      let profileArn = ''
      let region = ''
      let expiresAt = ''
      let clientId = ''
      let clientSecret = ''

      for (const key of SQLITE_TOKEN_KEYS) {
        const row = db.prepare('SELECT value FROM auth_kv WHERE key = ?').get(key) as
          | { value?: string }
          | undefined
        if (!row?.value) continue
        const tokenJson = JSON.parse(row.value)
        accessToken = tokenJson.access_token || tokenJson.accessToken || ''
        refreshToken = tokenJson.refresh_token || tokenJson.refreshToken || ''
        profileArn = tokenJson.profile_arn || tokenJson.profileArn || ''
        region = tokenJson.region || ''
        expiresAt = tokenJson.expires_at || tokenJson.expiresAt || ''
        break
      }

      for (const key of SQLITE_REGISTRATION_KEYS) {
        const row = db.prepare('SELECT value FROM auth_kv WHERE key = ?').get(key) as
          | { value?: string }
          | undefined
        if (!row?.value) continue
        const reg = JSON.parse(row.value)
        clientId = reg.client_id || reg.clientId || ''
        clientSecret = reg.client_secret || reg.clientSecret || ''
        if (reg.region && !region) region = reg.region
        break
      }

      try {
        const row = db
          .prepare("SELECT value FROM state WHERE key = 'api.codewhisperer.profile'")
          .get() as { value?: string } | undefined
        if (row?.value) {
          const profile = JSON.parse(row.value)
          if (profile.arn && !profileArn) profileArn = profile.arn
        }
      } catch {
        /* older databases may not have state table */
      }

      if (!refreshToken && !accessToken) return null

      const id = profileArn
        ? `kiro-profile-${sha256Short(profileArn)}`
        : `kiro-refresh-${sha256Short(refreshToken)}`
      return {
        id,
        enabled: true,
        label: dbPath.includes('amazon-q') ? 'Amazon Q CLI' : 'kiro-cli',
        refreshToken: refreshToken || undefined,
        accessToken: accessToken || undefined,
        expiresAt: expiresAt || undefined,
        profileArn: profileArn || undefined,
        clientId: clientId || undefined,
        clientSecret: clientSecret || undefined,
        region: region || undefined,
        sourceType: 'sqlite'
      }
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

export { writeJsonFile, accountIdentityKeys }
