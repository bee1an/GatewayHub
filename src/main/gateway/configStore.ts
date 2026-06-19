import { dirname, join, resolve, sep } from 'path'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { homedir } from 'os'
import type {
  ApiKeyEntry,
  GptWebAccountConfig,
  CodexAccountConfig,
  GatewayHubConfig,
  GatewayHubState,
  GrokWebAccountConfig,
  KiroAccountConfig,
  ModelMapping,
  NvidiaAccountConfig,
  OpenRouterAccountConfig,
  QoderAccountConfig,
  TraeAccountConfig,
  WindsurfAccountConfig
} from './types'
import {
  DEFAULT_KIRO_SETTINGS,
  SQLITE_TOKEN_KEYS,
  SQLITE_REGISTRATION_KEYS,
  normalizeKiroSettings,
  normalizeKiroModelId
} from './providers/kiro/constants'
import { DEFAULT_CODEX_SETTINGS } from './providers/codex/constants'
import { buildCodexAccountFromAuth } from './providers/codex/normalize'
import type { CodexAuthPayload } from './providers/codex/types'
import { DEFAULT_WINDSURF_SETTINGS } from './providers/windsurf/constants'
import { scanExternalWindsurfAccounts } from './providers/windsurf/localState'
import { DEFAULT_TRAE_SETTINGS, LEGACY_TRAE_MODEL_LIST_PATH } from './providers/trae/constants'
import { scanExternalTraeAccounts } from './providers/trae/localState'
import { DEFAULT_OPENROUTER_SETTINGS } from './providers/openrouter/constants'
import { DEFAULT_NVIDIA_SETTINGS } from './providers/nvidia/constants'
import { DEFAULT_GPT_WEB_SETTINGS } from './providers/gptWeb/constants'
import { DEFAULT_GROK_WEB_SETTINGS } from './providers/grokWeb/constants'
import { DEFAULT_QODER_SETTINGS, normalizeQoderMaxOutputTokens } from './providers/qoder/constants'
import { normalizeRequestRaceSettings } from './providers/requestRace'
import { generateApiKey, readJsonFile, sha256Short, writeJsonFile, atomicWrite } from './core/utils'
import { getPaths } from './core/paths'
import { normalizeKiroExpiresAt } from './providers/kiro/normalize'
import { importNodeSqlite } from './providers/kiro/sqlite'
import { AccountFileStore } from './core/accountStore'

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

  windsurfAccountsDir(): string {
    return join(dirname(this.configPath), 'windsurf', 'accounts')
  }

  traeAccountsDir(): string {
    return join(dirname(this.configPath), 'trae', 'accounts')
  }

  openrouterAccountsDir(): string {
    return join(dirname(this.configPath), 'openrouter', 'accounts')
  }

  nvidiaAccountsDir(): string {
    return join(dirname(this.configPath), 'nvidia', 'accounts')
  }

  gptWebAccountsDir(): string {
    return join(dirname(this.configPath), 'gptWeb', 'accounts')
  }

  grokWebAccountsDir(): string {
    return join(dirname(this.configPath), 'grokWeb', 'accounts')
  }

  qoderAccountsDir(): string {
    return join(dirname(this.configPath), 'qoder', 'accounts')
  }

  qoderAuthDir(): string {
    return join(dirname(this.configPath), 'qoder', 'auth')
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
      !parsed.providers?.nvidia ||
      !parsed.providers?.gptWeb ||
      !parsed.providers?.grokWeb ||
      !parsed.providers?.qoder ||
      parsed.providers?.trae?.settings?.modelListPath === LEGACY_TRAE_MODEL_LIST_PATH ||
      JSON.stringify(parsed.modelMappings ?? []) !== JSON.stringify(config.modelMappings)

    if (shouldSaveNormalizedConfig) {
      await this.saveConfig(config)
    }

    return config
  }

  async saveConfig(config: GatewayHubConfig): Promise<void> {
    const clone = JSON.parse(JSON.stringify(config))
    delete (clone.providers?.kiro as any)?.accounts
    // Strip runtime-injected proxy URLs so disk only stores the global server.proxyUrl
    // + each provider's useProxy flag. The registry re-derives settings.vpnProxyUrl on rebuild.
    for (const providerKey of [
      'kiro',
      'codex',
      'windsurf',
      'trae',
      'gptWeb',
      'grokWeb',
      'qoder'
    ] as const) {
      const settings = clone.providers?.[providerKey]?.settings
      if (settings && typeof settings === 'object') delete settings.vpnProxyUrl
    }
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

  private readonly kiroStore = new AccountFileStore<KiroAccountConfig>({
    dir: () => this.accountsDir(),
    providerLabel: 'account',
    backfillId: (data) => {
      if (!data.id) data.id = makeStableId(data)
      return data
    },
    fileNameSource: (data) => data.email || data.label || data.id,
    strip: (data) => {
      const { path: _path, ...rest } = data
      return rest
    },
    renameOnEmailChange: true
  })

  readAccountFiles(): Promise<KiroAccountConfig[]> {
    return this.kiroStore.readAll()
  }

  writeAccountFile(data: KiroAccountConfig): Promise<string> {
    return this.kiroStore.write(data)
  }

  deleteAccountFile(accountId: string): Promise<boolean> {
    return this.kiroStore.delete(accountId)
  }

  updateAccountFile(accountId: string, updates: Partial<KiroAccountConfig>): Promise<void> {
    return this.kiroStore.update(accountId, updates)
  }

  async scanExternalAccounts(): Promise<Array<KiroAccountConfig & { sourceType: string }>> {
    const candidates: Array<KiroAccountConfig & { sourceType: string }> = []
    const home = getPaths().home()

    const kiroJson = join(home, '.aws', 'sso', 'cache', 'kiro-auth-token.json')
    const kiroJsonAccount = await extractAccountFromJson(kiroJson, 'Kiro IDE credentials')
    if (kiroJsonAccount) candidates.push(kiroJsonAccount)

    const accountManagerBackup = join(
      home,
      'Library',
      'Application Support',
      'kiro-account-manager',
      'kiro-accounts.backup.json'
    )
    candidates.push(...(await extractAccountsFromKiroAccountManager(accountManagerBackup)))

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
      join(home, 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3'),
      join(home, 'Library', 'Application Support', 'amazon-q', 'data.sqlite3'),
      join(home, '.local', 'share', 'kiro-cli', 'data.sqlite3'),
      join(home, '.local', 'share', 'amazon-q', 'data.sqlite3')
    ]) {
      const account = await extractAccountFromSqlite(dbPath)
      if (account) candidates.push(account)
    }

    return candidates
  }

  async scanKiroAccounts(): Promise<{
    candidates: Array<
      KiroAccountConfig & {
        existing?: boolean
        existingAccountId?: string
        sourceType?: string
        updatable?: boolean
      }
    >
  }> {
    const external = await this.scanExternalAccounts()
    const existing = await this.readAccountFiles()
    const existingKeys = new Map<string, KiroAccountConfig>()
    for (const acc of existing) {
      for (const k of accountIdentityKeys(acc)) {
        if (!existingKeys.has(k)) existingKeys.set(k, acc)
      }
    }

    const result: Array<
      KiroAccountConfig & {
        existing?: boolean
        existingAccountId?: string
        sourceType?: string
        updatable?: boolean
      }
    > = []
    for (const candidate of external) {
      const keys = accountIdentityKeys(candidate)
      const existingAccount = keys.map((k) => existingKeys.get(k)).find(Boolean)
      const isExisting = Boolean(existingAccount)
      result.push({
        ...candidate,
        existing: isExisting || undefined,
        existingAccountId: existingAccount?.id,
        updatable:
          existingAccount && isKiroAccountCandidateNewer(candidate, existingAccount)
            ? true
            : undefined
      })
    }
    return { candidates: result }
  }

  // ============== Codex account file management ==============

  private readonly codexStore = new AccountFileStore<CodexAccountConfig>({
    dir: () => this.codexAccountsDir(),
    providerLabel: 'codex',
    backfillId: (data) => data,
    fileNameSource: (data) => data.email || data.label || data.id,
    strip: (data) => {
      const { path: _path, ...rest } = data
      return rest
    },
    renameOnEmailChange: true
  })

  readCodexAccountFiles(): Promise<CodexAccountConfig[]> {
    return this.codexStore.readAll()
  }

  writeCodexAccountFile(data: CodexAccountConfig): Promise<string> {
    return this.codexStore.write(data)
  }

  deleteCodexAccountFile(accountId: string): Promise<boolean> {
    return this.codexStore.delete(accountId)
  }

  updateCodexAccountFile(accountId: string, updates: Partial<CodexAccountConfig>): Promise<void> {
    return this.codexStore.update(accountId, updates)
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

  // ============== Windsurf account file management ==============

  private readonly windsurfStore = new AccountFileStore<WindsurfAccountConfig>({
    dir: () => this.windsurfAccountsDir(),
    providerLabel: 'windsurf',
    backfillId: (data) => data,
    fileNameSource: (data) => data.email || data.label || data.id,
    strip: (data) => {
      const { path: _path, ...rest } = data
      return rest
    }
  })

  readWindsurfAccountFiles(): Promise<WindsurfAccountConfig[]> {
    return this.windsurfStore.readAll()
  }

  writeWindsurfAccountFile(data: WindsurfAccountConfig): Promise<string> {
    return this.windsurfStore.write(data)
  }

  deleteWindsurfAccountFile(accountId: string): Promise<boolean> {
    return this.windsurfStore.delete(accountId)
  }

  updateWindsurfAccountFile(
    accountId: string,
    updates: Partial<WindsurfAccountConfig>
  ): Promise<void> {
    return this.windsurfStore.update(accountId, updates)
  }

  async scanWindsurfAccounts(): Promise<{
    candidates: Array<WindsurfAccountConfig & { existing?: boolean; sourceType?: string }>
  }> {
    const external = await this.scanExternalWindsurfAccounts()
    const existing = await this.readWindsurfAccountFiles()
    const existingKeys = new Set<string>()
    for (const acc of existing) {
      for (const key of windsurfIdentityKeys(acc)) existingKeys.add(key)
    }
    const result: Array<WindsurfAccountConfig & { existing?: boolean; sourceType?: string }> = []
    for (const candidate of external) {
      const keys = windsurfIdentityKeys(candidate)
      const isExisting = keys.some((key) => existingKeys.has(key))
      result.push({ ...candidate, existing: isExisting || undefined })
    }
    return { candidates: result }
  }

  private async scanExternalWindsurfAccounts(): Promise<
    Array<WindsurfAccountConfig & { sourceType: string }>
  > {
    return scanExternalWindsurfAccounts()
  }

  // ============== Trae account file management ==============

  private readonly traeStore = new AccountFileStore<TraeAccountConfig>({
    dir: () => this.traeAccountsDir(),
    providerLabel: 'trae',
    backfillId: (data) => {
      if (!data.id) data.id = makeTraeStableId(data)
      return data
    },
    fileNameSource: (data) => data.email || data.label || data.id,
    // Trae strip also drops scan-time-only fields (sourceType / existing).
    strip: (data) => {
      const {
        path: _path,
        sourceType: _sourceType,
        existing: _existing,
        ...rest
      } = data as TraeAccountConfig & { sourceType?: string; existing?: boolean }
      return rest
    },
    renameOnEmailChange: true
  })

  readTraeAccountFiles(): Promise<TraeAccountConfig[]> {
    return this.traeStore.readAll()
  }

  writeTraeAccountFile(data: TraeAccountConfig): Promise<string> {
    return this.traeStore.write(data)
  }

  deleteTraeAccountFile(accountId: string): Promise<boolean> {
    return this.traeStore.delete(accountId)
  }

  updateTraeAccountFile(accountId: string, updates: Partial<TraeAccountConfig>): Promise<void> {
    return this.traeStore.update(accountId, updates)
  }

  async scanTraeAccounts(): Promise<{
    candidates: Array<TraeAccountConfig & { existing?: boolean; sourceType?: string }>
  }> {
    const external = await this.scanExternalTraeAccounts()
    const existing = await this.readTraeAccountFiles()
    const existingKeys = new Set<string>()
    for (const acc of existing) {
      for (const key of traeIdentityKeys(acc)) existingKeys.add(key)
    }
    const result: Array<TraeAccountConfig & { existing?: boolean; sourceType?: string }> = []
    for (const candidate of external) {
      const keys = traeIdentityKeys(candidate)
      const isExisting = keys.some((key) => existingKeys.has(key))
      result.push({ ...candidate, existing: isExisting || undefined })
    }
    return { candidates: result }
  }

  private async scanExternalTraeAccounts(): Promise<
    Array<TraeAccountConfig & { sourceType: string }>
  > {
    return scanExternalTraeAccounts()
  }

  // ============== OpenRouter account file management ==============

  private readonly openrouterStore = new AccountFileStore<OpenRouterAccountConfig>({
    dir: () => this.openrouterAccountsDir(),
    providerLabel: 'openrouter',
    backfillId: (data) => {
      if (!data.id) data.id = `openrouter-${sha256Short(data.apiKey || Math.random().toString())}`
      return data
    },
    validate: (data) => (data.apiKey ? data : null),
    fileNameSource: (data) => data.label || data.id,
    strip: (data) => {
      const { path: _path, ...rest } = data
      return rest
    }
  })

  readOpenRouterAccountFiles(): Promise<OpenRouterAccountConfig[]> {
    return this.openrouterStore.readAll()
  }

  writeOpenRouterAccountFile(data: OpenRouterAccountConfig): Promise<string> {
    return this.openrouterStore.write(data)
  }

  deleteOpenRouterAccountFile(accountId: string): Promise<boolean> {
    return this.openrouterStore.delete(accountId)
  }

  updateOpenRouterAccountFile(
    accountId: string,
    updates: Partial<OpenRouterAccountConfig>
  ): Promise<void> {
    return this.openrouterStore.update(accountId, updates)
  }

  // ============== NVIDIA account file management ==============

  private readonly nvidiaStore = new AccountFileStore<NvidiaAccountConfig>({
    dir: () => this.nvidiaAccountsDir(),
    providerLabel: 'nvidia',
    backfillId: (data) => {
      if (!data.id) data.id = `nvidia-${sha256Short(data.apiKey || Math.random().toString())}`
      return data
    },
    validate: (data) => (data.apiKey ? data : null),
    fileNameSource: (data) => data.label || data.id,
    strip: (data) => {
      const { path: _path, ...rest } = data
      return rest
    }
  })

  readNvidiaAccountFiles(): Promise<NvidiaAccountConfig[]> {
    return this.nvidiaStore.readAll()
  }

  writeNvidiaAccountFile(data: NvidiaAccountConfig): Promise<string> {
    return this.nvidiaStore.write(data)
  }

  deleteNvidiaAccountFile(accountId: string): Promise<boolean> {
    return this.nvidiaStore.delete(accountId)
  }

  updateNvidiaAccountFile(accountId: string, updates: Partial<NvidiaAccountConfig>): Promise<void> {
    return this.nvidiaStore.update(accountId, updates)
  }

  // ============== GptWeb account file management ==============

  private readonly gptWebStore = new AccountFileStore<GptWebAccountConfig>({
    dir: () => this.gptWebAccountsDir(),
    providerLabel: 'gptWeb',
    backfillId: (data) => {
      if (!data.id && data.accessToken)
        data.id = `gptWeb-${sha256Short(data.accessToken.slice(0, 32))}`
      return data
    },
    validate: (data) => (data.accessToken ? data : null),
    fileNameSource: (data) => data.label || data.email || data.id,
    strip: (data) => {
      const { path: _path, ...rest } = data
      return rest
    }
  })

  readGptWebAccountFiles(): Promise<GptWebAccountConfig[]> {
    return this.gptWebStore.readAll()
  }

  writeGptWebAccountFile(data: GptWebAccountConfig): Promise<string> {
    return this.gptWebStore.write(data)
  }

  deleteGptWebAccountFile(accountId: string): Promise<boolean> {
    return this.gptWebStore.delete(accountId)
  }

  updateGptWebAccountFile(accountId: string, updates: Partial<GptWebAccountConfig>): Promise<void> {
    return this.gptWebStore.update(accountId, updates)
  }

  // ============== Grok Web account file management ==============

  private readonly grokWebStore = new AccountFileStore<GrokWebAccountConfig>({
    dir: () => this.grokWebAccountsDir(),
    providerLabel: 'grokWeb',
    backfillId: (data) => {
      if (!data.id && data.cookieHeader)
        data.id = `grokWeb-${sha256Short(data.cookieHeader.slice(0, 64))}`
      return data
    },
    validate: (data) => (data.cookieHeader ? data : null),
    fileNameSource: (data) => data.label || data.email || data.id,
    strip: (data) => {
      const { path: _path, ...rest } = data
      return rest
    }
  })

  readGrokWebAccountFiles(): Promise<GrokWebAccountConfig[]> {
    return this.grokWebStore.readAll()
  }

  writeGrokWebAccountFile(data: GrokWebAccountConfig): Promise<string> {
    return this.grokWebStore.write(data)
  }

  deleteGrokWebAccountFile(accountId: string): Promise<boolean> {
    return this.grokWebStore.delete(accountId)
  }

  updateGrokWebAccountFile(
    accountId: string,
    updates: Partial<GrokWebAccountConfig>
  ): Promise<void> {
    return this.grokWebStore.update(accountId, updates)
  }

  // ============== Qoder account file management ==============

  private readonly qoderStore = new AccountFileStore<QoderAccountConfig>({
    dir: () => this.qoderAccountsDir(),
    providerLabel: 'qoder',
    backfillId: (data) => {
      if (!data.id) {
        data.id =
          data.authType === 'qoder-cli-auth'
            ? `qoder-cli-${sha256Short(data.qoderCliHome || data.qoderCliPath || 'default')}`
            : `qoder-${sha256Short(data.personalAccessToken || Math.random().toString())}`
      }
      return data
    },
    // Qoder authType normalization FSM (mirrors the original per-file logic).
    validate: (data) => {
      if (data.personalAccessToken && data.authType !== 'qoder-cli-auth')
        data.authType = 'qoder-personal-access-token'
      if (!data.authType && data.qoderCliHome) data.authType = 'qoder-cli-auth'
      if (data.authType === 'qoder-cli-login' && data.qoderCliHome) {
        data.authType = 'qoder-cli-auth'
      }
      if (data.authType === 'qoder-cli-auth' && !data.qoderCliHome) return null
      if (data.authType !== 'qoder-cli-auth' && !data.personalAccessToken) return null
      // Refuse any qoderCliHome that escapes the managed auth directory.
      // The request path reads `<qoderCliHome>/.qoder/.auth/*` directly, so an
      // out-of-tree value (e.g. a hostile pasted JSON pointing at another user's
      // home) would let the gateway surface someone else's credentials. Only
      // paths under qoderAuthDir() are trusted; everything else is dropped.
      if (data.qoderCliHome && !isPathInside(data.qoderCliHome, this.qoderAuthDir())) {
        return null
      }
      return data
    },
    fileNameSource: (data) => data.label || data.email || data.id,
    strip: (data) => {
      const { path: _path, ...rest } = data
      return rest
    },
    renameOnEmailChange: true
  })

  readQoderAccountFiles(): Promise<QoderAccountConfig[]> {
    return this.qoderStore.readAll()
  }

  writeQoderAccountFile(data: QoderAccountConfig): Promise<string> {
    return this.qoderStore.write(data)
  }

  deleteQoderAccountFile(accountId: string): Promise<boolean> {
    return this.qoderStore.delete(accountId)
  }

  async deleteQoderAuthHome(qoderCliHome?: string): Promise<boolean> {
    if (!qoderCliHome) return false
    const root = resolve(this.qoderAuthDir())
    const target = resolve(qoderCliHome)
    // Allow deleting the auth root itself (cleanup) OR any path strictly under it.
    if (target !== root && !isPathInside(target, root)) return false
    await rm(target, { recursive: true, force: true })
    return true
  }

  updateQoderAccountFile(accountId: string, updates: Partial<QoderAccountConfig>): Promise<void> {
    return this.qoderStore.update(accountId, updates)
  }

  defaultConfig(): GatewayHubConfig {
    return {
      version: 3,
      server: {
        host: '127.0.0.1',
        port: 9741,
        apiKeys: [generateApiKey()],
        autoStart: false,
        proxyUrl: ''
      },
      defaultProvider: 'kiro',
      providers: {
        kiro: {
          enabled: true,
          useProxy: false,
          routeName: 'kiro',
          settings: { ...DEFAULT_KIRO_SETTINGS }
        },
        codex: {
          enabled: true,
          useProxy: false,
          routeName: 'codex',
          settings: { ...DEFAULT_CODEX_SETTINGS }
        },
        windsurf: {
          enabled: true,
          useProxy: false,
          routeName: 'windsurf',
          settings: { ...DEFAULT_WINDSURF_SETTINGS }
        },
        trae: {
          enabled: true,
          useProxy: false,
          routeName: 'trae',
          settings: { ...DEFAULT_TRAE_SETTINGS }
        },
        openrouter: {
          enabled: true,
          routeName: 'openrouter',
          settings: { ...DEFAULT_OPENROUTER_SETTINGS }
        },
        nvidia: {
          enabled: true,
          routeName: 'nvidia',
          settings: { ...DEFAULT_NVIDIA_SETTINGS }
        },
        gptWeb: {
          enabled: true,
          useProxy: false,
          routeName: 'gptWeb',
          settings: { ...DEFAULT_GPT_WEB_SETTINGS }
        },
        grokWeb: {
          enabled: true,
          useProxy: false,
          routeName: 'grokWeb',
          settings: { ...DEFAULT_GROK_WEB_SETTINGS }
        },
        qoder: {
          enabled: true,
          useProxy: false,
          routeName: 'qoder',
          settings: { ...DEFAULT_QODER_SETTINGS }
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
        },
        windsurf: {
          accounts: {},
          currentAccountIndex: 0,
          logs: []
        },
        trae: {
          accounts: {},
          currentAccountIndex: 0,
          logs: []
        },
        openrouter: {
          accounts: {},
          currentAccountIndex: 0,
          logs: []
        },
        nvidia: {
          accounts: {},
          currentAccountIndex: 0,
          logs: []
        },
        gptWeb: {
          accounts: {},
          currentAccountIndex: 0,
          logs: []
        },
        grokWeb: {
          accounts: {},
          currentAccountIndex: 0,
          logs: []
        },
        qoder: {
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
    const traeSettings = {
      ...defaults.providers.trae.settings,
      ...(input?.providers?.trae?.settings ?? {})
    }
    if (traeSettings.modelListPath === LEGACY_TRAE_MODEL_LIST_PATH) {
      traeSettings.modelListPath = defaults.providers.trae.settings.modelListPath
    }
    const qoderSettings = {
      ...defaults.providers.qoder.settings,
      ...(input?.providers?.qoder?.settings ?? {})
    }
    qoderSettings.maxOutputTokens = normalizeQoderMaxOutputTokens(qoderSettings.maxOutputTokens)

    // 迁移：旧版每个 provider 的 settings.vpnProxyUrl 曾是代理 URL 来源。新模型里代理 URL
    // 统一存到 server.proxyUrl（来源取 kiro），provider 改用 useProxy 开关。任何旧的非空
    // vpnProxyUrl 都迁移成 useProxy=true；kiro 的非空值同时晋升为全局 server.proxyUrl。
    const legacyKiroProxy =
      typeof input?.providers?.kiro?.settings?.vpnProxyUrl === 'string'
        ? input.providers.kiro.settings.vpnProxyUrl.trim()
        : ''
    const migratedServerProxy =
      typeof input?.server?.proxyUrl === 'string'
        ? input.server.proxyUrl
        : legacyKiroProxy || defaults.server.proxyUrl
    const resolveUseProxy = (providerKey: string): boolean => {
      const explicit = input?.providers?.[providerKey]?.useProxy
      if (typeof explicit === 'boolean') return explicit
      const legacy =
        typeof input?.providers?.[providerKey]?.settings?.vpnProxyUrl === 'string'
          ? input.providers[providerKey].settings.vpnProxyUrl.trim()
          : ''
      return legacy !== ''
    }

    const config: GatewayHubConfig = {
      ...defaults,
      ...input,
      server: { ...defaults.server, ...(input?.server ?? {}), proxyUrl: migratedServerProxy },
      providers: {
        ...defaults.providers,
        ...(input?.providers ?? {}),
        kiro: {
          ...defaults.providers.kiro,
          ...(input?.providers?.kiro ?? {}),
          routeName: input?.providers?.kiro?.routeName || defaults.providers.kiro.routeName,
          useProxy: resolveUseProxy('kiro'),
          settings: normalizeKiroSettings({
            ...defaults.providers.kiro.settings,
            ...(input?.providers?.kiro?.settings ?? {})
          })
        },
        codex: {
          ...defaults.providers.codex,
          ...(inputCodex ?? {}),
          routeName: input?.providers?.codex?.routeName || defaults.providers.codex.routeName,
          enabled:
            typeof input?.providers?.codex?.enabled === 'boolean'
              ? input.providers.codex.enabled
              : defaults.providers.codex.enabled,
          useProxy: resolveUseProxy('codex'),
          settings: {
            ...defaults.providers.codex.settings,
            ...(input?.providers?.codex?.settings ?? {})
          }
        },
        windsurf: {
          ...defaults.providers.windsurf,
          ...(input?.providers?.windsurf ?? {}),
          routeName: input?.providers?.windsurf?.routeName || defaults.providers.windsurf.routeName,
          enabled:
            typeof input?.providers?.windsurf?.enabled === 'boolean'
              ? input.providers.windsurf.enabled
              : defaults.providers.windsurf.enabled,
          useProxy: resolveUseProxy('windsurf'),
          settings: {
            ...defaults.providers.windsurf.settings,
            ...(input?.providers?.windsurf?.settings ?? {})
          }
        },
        trae: {
          ...defaults.providers.trae,
          ...(input?.providers?.trae ?? {}),
          routeName: input?.providers?.trae?.routeName || defaults.providers.trae.routeName,
          enabled:
            typeof input?.providers?.trae?.enabled === 'boolean'
              ? input.providers.trae.enabled
              : defaults.providers.trae.enabled,
          useProxy: resolveUseProxy('trae'),
          settings: traeSettings
        },
        openrouter: {
          ...defaults.providers.openrouter,
          ...(input?.providers?.openrouter ?? {}),
          routeName:
            input?.providers?.openrouter?.routeName || defaults.providers.openrouter.routeName,
          enabled:
            typeof input?.providers?.openrouter?.enabled === 'boolean'
              ? input.providers.openrouter.enabled
              : defaults.providers.openrouter.enabled,
          settings: normalizeRequestRaceSettings({
            ...defaults.providers.openrouter.settings,
            ...(input?.providers?.openrouter?.settings ?? {})
          })
        },
        nvidia: {
          ...defaults.providers.nvidia,
          ...(input?.providers?.nvidia ?? {}),
          routeName: input?.providers?.nvidia?.routeName || defaults.providers.nvidia.routeName,
          enabled:
            typeof input?.providers?.nvidia?.enabled === 'boolean'
              ? input.providers.nvidia.enabled
              : defaults.providers.nvidia.enabled,
          settings: normalizeRequestRaceSettings({
            ...defaults.providers.nvidia.settings,
            ...(input?.providers?.nvidia?.settings ?? {})
          })
        },
        gptWeb: {
          ...defaults.providers.gptWeb,
          ...(input?.providers?.gptWeb ?? {}),
          routeName: input?.providers?.gptWeb?.routeName || defaults.providers.gptWeb.routeName,
          enabled:
            typeof input?.providers?.gptWeb?.enabled === 'boolean'
              ? input.providers.gptWeb.enabled
              : defaults.providers.gptWeb.enabled,
          useProxy: resolveUseProxy('gptWeb'),
          settings: {
            ...defaults.providers.gptWeb.settings,
            ...(input?.providers?.gptWeb?.settings ?? {})
          }
        },
        grokWeb: {
          ...defaults.providers.grokWeb,
          ...(input?.providers?.grokWeb ?? {}),
          routeName: input?.providers?.grokWeb?.routeName || defaults.providers.grokWeb.routeName,
          enabled:
            typeof input?.providers?.grokWeb?.enabled === 'boolean'
              ? input.providers.grokWeb.enabled
              : defaults.providers.grokWeb.enabled,
          useProxy: resolveUseProxy('grokWeb'),
          settings: {
            ...defaults.providers.grokWeb.settings,
            ...(input?.providers?.grokWeb?.settings ?? {})
          }
        },
        qoder: {
          ...defaults.providers.qoder,
          ...(input?.providers?.qoder ?? {}),
          routeName: input?.providers?.qoder?.routeName || defaults.providers.qoder.routeName,
          enabled:
            typeof input?.providers?.qoder?.enabled === 'boolean'
              ? input.providers.qoder.enabled
              : defaults.providers.qoder.enabled,
          useProxy: resolveUseProxy('qoder'),
          settings: {
            ...qoderSettings
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
        },
        windsurf: {
          ...defaults.providers.windsurf,
          ...(input?.providers?.windsurf ?? {}),
          accounts: input?.providers?.windsurf?.accounts ?? {},
          logs: Array.isArray(input?.providers?.windsurf?.logs)
            ? input.providers.windsurf.logs.slice(-1000)
            : []
        },
        trae: {
          ...defaults.providers.trae,
          ...(input?.providers?.trae ?? {}),
          accounts: input?.providers?.trae?.accounts ?? {},
          logs: Array.isArray(input?.providers?.trae?.logs)
            ? input.providers.trae.logs.slice(-1000)
            : []
        },
        openrouter: {
          ...defaults.providers.openrouter,
          ...(input?.providers?.openrouter ?? {}),
          accounts: input?.providers?.openrouter?.accounts ?? {},
          logs: Array.isArray(input?.providers?.openrouter?.logs)
            ? input.providers.openrouter.logs.slice(-1000)
            : []
        },
        nvidia: {
          ...defaults.providers.nvidia,
          ...(input?.providers?.nvidia ?? {}),
          accounts: input?.providers?.nvidia?.accounts ?? {},
          logs: Array.isArray(input?.providers?.nvidia?.logs)
            ? input.providers.nvidia.logs.slice(-1000)
            : []
        },
        gptWeb: {
          ...defaults.providers.gptWeb,
          ...(input?.providers?.gptWeb ?? {}),
          accounts: input?.providers?.gptWeb?.accounts ?? {},
          logs: Array.isArray(input?.providers?.gptWeb?.logs)
            ? input.providers.gptWeb.logs.slice(-1000)
            : []
        },
        grokWeb: {
          ...defaults.providers.grokWeb,
          ...(input?.providers?.grokWeb ?? {}),
          accounts: input?.providers?.grokWeb?.accounts ?? {},
          logs: Array.isArray(input?.providers?.grokWeb?.logs)
            ? input.providers.grokWeb.logs.slice(-1000)
            : []
        },
        qoder: {
          ...defaults.providers.qoder,
          ...(input?.providers?.qoder ?? {}),
          accounts: input?.providers?.qoder?.accounts ?? {},
          logs: Array.isArray(input?.providers?.qoder?.logs)
            ? input.providers.qoder.logs.slice(-1000)
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

function isKiroAccountCandidateNewer(
  candidate: Partial<KiroAccountConfig>,
  existing: Partial<KiroAccountConfig>
): boolean {
  for (const key of [
    'refreshToken',
    'accessToken',
    'expiresAt',
    'profileArn',
    'clientId',
    'clientSecret',
    'region',
    'apiRegion',
    'email'
  ] as const) {
    if (candidate[key] && candidate[key] !== existing[key]) return true
  }
  return false
}

function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : undefined
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

function makeTraeStableId(account: Partial<TraeAccountConfig>): string {
  if (account.userId) return `trae-user-${sha256Short(account.userId, 12)}`
  if (account.refreshToken) return `trae-refresh-${sha256Short(account.refreshToken, 12)}`
  if (account.jwtToken) return `trae-jwt-${sha256Short(account.jwtToken, 12)}`
  return `trae-${sha256Short(Math.random().toString(), 12)}`
}

function codexIdentityKeys(account: Partial<CodexAccountConfig>): string[] {
  const keys: string[] = []
  if (account.gptWebAccountId) keys.push(`codex-acct:${account.gptWebAccountId}`)
  if (account.email) keys.push(`codex-email:${account.email.toLowerCase()}`)
  if (account.refreshToken) keys.push(`codex-refresh:${sha256Short(account.refreshToken)}`)
  if (!keys.length && account.accessToken)
    keys.push(`codex-access:${sha256Short(account.accessToken)}`)
  return keys
}

function windsurfIdentityKeys(account: Partial<WindsurfAccountConfig>): string[] {
  const keys: string[] = []
  if (account.email) keys.push(`windsurf-email:${account.email.toLowerCase()}`)
  if (account.apiKey) keys.push(`windsurf-api:${sha256Short(account.apiKey)}`)
  if (!keys.length && account.id) keys.push(`windsurf-id:${account.id}`)
  return keys
}

function traeIdentityKeys(account: Partial<TraeAccountConfig>): string[] {
  const keys: string[] = []
  if (account.userId) keys.push(`trae-user:${account.userId}`)
  if (account.email) keys.push(`trae-email:${account.email.toLowerCase()}`)
  if (account.refreshToken) keys.push(`trae-refresh:${sha256Short(account.refreshToken)}`)
  if (!keys.length && account.jwtToken) keys.push(`trae-jwt:${sha256Short(account.jwtToken)}`)
  if (!keys.length && account.id) keys.push(`trae-id:${account.id}`)
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
      expiresAt: normalizeKiroExpiresAt(data.expiresAt ?? data.expires_at),
      region: data.region || undefined,
      apiRegion: data.apiRegion || data.api_region || undefined,
      sourceType: 'json'
    }
  } catch {
    return null
  }
}

async function extractAccountsFromKiroAccountManager(
  path: string
): Promise<Array<KiroAccountConfig & { sourceType: string }>> {
  try {
    const data = await readJsonFile<any>(path)
    const rawAccounts = data?.accounts
    const activeAccountId =
      typeof data?.activeAccountId === 'string' && data.activeAccountId ? data.activeAccountId : ''
    const entries: Array<[string, any]> = Array.isArray(rawAccounts)
      ? rawAccounts.map((account, index) => [String(account?.id ?? index), account])
      : rawAccounts && typeof rawAccounts === 'object'
        ? Object.entries(rawAccounts)
        : []

    entries.sort(([leftId], [rightId]) => {
      if (leftId === activeAccountId) return -1
      if (rightId === activeAccountId) return 1
      return 0
    })

    const accounts: Array<KiroAccountConfig & { sourceType: string }> = []
    for (const [entryId, account] of entries) {
      if (!account || typeof account !== 'object') continue
      const credentials = parseCredentialsObject(account.credentials)
      if (!credentials) continue

      const refreshToken = credentials.refreshToken || credentials.refresh_token || ''
      const accessToken = credentials.accessToken || credentials.access_token || ''
      if (!refreshToken && !accessToken) continue

      const profileArn =
        credentials.profileArn ||
        credentials.profile_arn ||
        account.profileArn ||
        account.profile_arn ||
        ''
      const email = normalizeEmail(account.email || credentials.email)
      const label =
        email ||
        (typeof account.nickname === 'string' && account.nickname.trim()) ||
        (entryId === activeAccountId
          ? 'Kiro account-manager active account'
          : 'Kiro account-manager')
      const id = profileArn
        ? `kiro-profile-${sha256Short(profileArn)}`
        : refreshToken
          ? `kiro-refresh-${sha256Short(refreshToken)}`
          : `kiro-access-${sha256Short(accessToken)}`

      accounts.push({
        id,
        email,
        label,
        enabled: true,
        refreshToken: refreshToken || undefined,
        accessToken: accessToken || undefined,
        expiresAt: normalizeKiroExpiresAt(credentials.expiresAt ?? credentials.expires_at),
        profileArn: profileArn || undefined,
        clientId: credentials.clientId || credentials.client_id || undefined,
        clientSecret: credentials.clientSecret || credentials.client_secret || undefined,
        region: credentials.region || account.region || undefined,
        apiRegion:
          credentials.apiRegion || credentials.api_region || account.apiRegion || undefined,
        sourceType: 'account-manager'
      })
    }

    return accounts
  } catch {
    return []
  }
}

function parseCredentialsObject(value: unknown): Record<string, any> | null {
  if (!value) return null
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
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
    const sqlite = await importNodeSqlite()
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
        expiresAt: normalizeKiroExpiresAt(expiresAt),
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

/**
 * True when `target` resolves to a path strictly below `root` (not equal to root).
 * Used to keep qoderCliHome inside the managed auth directory so a hostile
 * pasted JSON cannot point the gateway at an out-of-tree credential bundle.
 */
function isPathInside(target: string, root: string): boolean {
  const t = resolve(target)
  const r = resolve(root)
  return r !== t && t.startsWith(`${r}${sep}`)
}
