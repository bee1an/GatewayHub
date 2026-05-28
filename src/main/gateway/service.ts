import { dirname, join } from 'path'
import type {
  AccountStatus,
  AccountTestResult,
  ApiKeyEntry,
  CodexAccountConfig,
  GatewayHubConfig,
  GatewayHubState,
  GatewayLogEntry,
  GatewayStatusSnapshot,
  KiroAccountConfig,
  LogCategory,
  ModelMapping,
  ProviderStatus
} from './types'
import { GatewayConfigStore, sanitizeModelMappings } from './configStore'
import { GatewayLogger } from './core/logger'
import { DEFAULT_LOG_WRITER_CONFIG, type LogWriterConfig } from './core/logWriter'
import { ProviderRegistry } from './providerRegistry'
import { GatewayServer } from './server'
import { PricingTable, loadPricingOverrides, type ModelPrice } from './core/pricing'
import { UsageStore, defaultUsageStorePath } from './core/usageStore'
import { sha256Short, toErrorMessage, generateApiKeyString } from './core/utils'
import {
  normalizeImportedAccount,
  resolveRefreshTokenAccount,
  buildKiroAccountConfig
} from './providers/kiro/normalize'
import {
  detectKiroCli as detectCli,
  loginWithKiroCli as loginCli,
  cancelKiroCliLogin as cancelCli,
  setOnAccountImported,
  type CliDetectResult
} from './providers/kiro/cliLogin'
import { buildCodexAccountFromAuth, parseCodexAuthInput } from './providers/codex/normalize'
import {
  cancelCodexBrowserLogin,
  cancelCodexDeviceLogin,
  loginCodexWithBrowser,
  loginCodexWithDevice,
  setOnCodexAccountImported,
  type LoginEventListener
} from './providers/codex/login'

export class GatewayHubService {
  private readonly store = new GatewayConfigStore()
  private readonly writerConfig: LogWriterConfig = {
    logDir: '',
    ...DEFAULT_LOG_WRITER_CONFIG
  }
  private readonly logger = new GatewayLogger({
    maxEntries: 1000,
    writer: this.writerConfig
  })
  private pricing = new PricingTable()
  private usageStore?: UsageStore
  private config?: GatewayHubConfig
  private state?: GatewayHubState
  private registry?: ProviderRegistry
  private server?: GatewayServer
  private saveTimer?: NodeJS.Timeout
  private lastUsedMap = new Map<string, number>()
  private lastUsedFlushTimer?: NodeJS.Timeout
  private initPromise?: Promise<void>

  get configPath(): string {
    return this.store.configPath
  }

  get statePath(): string {
    return this.store.statePath
  }

  /** 幂等入口：直接调或经 ensureReady() 进来都共享同一个 initPromise，避免并发初始化死锁。 */
  async initialize(options?: { skipAutoStart?: boolean }): Promise<void> {
    if (this.initPromise) return this.initPromise
    this.initPromise = this.initializeImpl(options).catch((err) => {
      this.initPromise = undefined // 失败后允许重试
      throw err
    })
    return this.initPromise
  }

  private async initializeImpl(options?: { skipAutoStart?: boolean }): Promise<void> {
    await this.store.migrateIfNeeded()
    this.config = await this.store.loadConfig()
    this.state = await this.store.loadState()
    this.logger.replace(this.state.providers.kiro.logs ?? [])

    // Initialize log writer with resolved path
    this.writerConfig.logDir = this.store.logsDir()
    await this.logger.initialize()

    // 加载价格覆盖（~/.config/gatewayhub/pricing.json）
    const overrides = await loadPricingOverrides(
      join(dirname(this.store.configPath), 'pricing.json')
    )
    this.pricing = new PricingTable(overrides)

    // 初始化用量持久化 store（~/.config/gatewayhub/usage-store/v1.json）
    this.usageStore = new UsageStore({
      filePath: defaultUsageStorePath(dirname(this.store.configPath)),
      pricing: this.pricing
    })

    this.logger.info('GatewayHub service initialized', { category: 'system' })

    setOnAccountImported(async (account) => {
      await this.ensureReady()
      const existing = await this.store.readAccountFiles()
      const match = existing.find((a) => a.id === account.id)
      if (match) {
        await this.store.updateAccountFile(account.id, {
          refreshToken: account.refreshToken,
          accessToken: account.accessToken,
          expiresAt: account.expiresAt,
          profileArn: account.profileArn,
          clientId: account.clientId,
          clientSecret: account.clientSecret,
          region: account.region
        })
      } else {
        await this.store.writeAccountFile(account)
      }
      await this.rebuildRuntime(this.server?.running ?? false)
    })

    setOnCodexAccountImported(async (account) => {
      await this.ensureReady()
      const existing = await this.store.readCodexAccountFiles()
      const match = existing.find((a) => a.id === account.id)
      if (match) {
        await this.store.updateCodexAccountFile(account.id, {
          refreshToken: account.refreshToken,
          accessToken: account.accessToken,
          idToken: account.idToken,
          chatgptAccountId: account.chatgptAccountId,
          expiresAt: account.expiresAt,
          lastRefresh: account.lastRefresh,
          subscriptionActiveUntil: account.subscriptionActiveUntil,
          email: account.email,
          name: account.name
        })
      } else {
        await this.store.writeCodexAccountFile(account)
      }
      await this.rebuildRuntime(this.server?.running ?? false)
    })

    const accounts = await this.store.readAccountFiles()
    if (accounts.length === 0) {
      // 内联自动发现逻辑：调 this.autoDiscoverKiroAccounts() 会经 ensureReady() 与本次 init 自死锁
      const { candidates } = await this.store.scanKiroAccounts()
      for (const candidate of candidates.filter((c) => !c.existing)) {
        try {
          await this.store.writeAccountFile(candidate)
        } catch {
          // skip failed writes
        }
      }
    }
    await this.rebuildRuntime(false)

    if (this.config.server.autoStart && !options?.skipAutoStart) {
      try {
        // 同理：不能调 this.start()，会 ensureReady() 自等待
        await this.server!.start()
      } catch (err) {
        // 端口被占用等启动失败时，不要让应用初始化整体失败：
        // server.start 已经写过 error 日志，UI 通过 status() 看到 running=false 即可。
        this.logger.error(
          `Auto-start failed: ${err instanceof Error ? err.message : String(err)}`,
          { category: 'system' }
        )
      }
    }
  }

  async start(): Promise<GatewayStatusSnapshot> {
    await this.ensureReady()
    await this.server!.start()
    return this.getStatus()
  }

  async stop(): Promise<GatewayStatusSnapshot> {
    if (this.server) await this.server.stop()
    return this.getStatus()
  }

  async getStatus(): Promise<GatewayStatusSnapshot> {
    await this.ensureReady()
    const providers = (await this.registry!.statuses()) as ProviderStatus[]
    const apiKeys = this.config!.server.apiKeys.map((entry) => ({
      ...entry,
      lastUsedAt: this.lastUsedMap.get(entry.id) ?? entry.lastUsedAt
    }))
    return {
      server: {
        running: this.server!.running,
        url: this.server!.url,
        host: this.config!.server.host,
        port: this.config!.server.port,
        apiKeys
      },
      configPath: this.store.configPath,
      statePath: this.store.statePath,
      providers,
      logs: this.logger.getEntries()
    }
  }

  async autoDiscoverKiroAccounts(): Promise<{
    added: KiroAccountConfig[]
    skipped: number
    status: GatewayStatusSnapshot
  }> {
    await this.ensureReady()
    const { candidates } = await this.store.scanKiroAccounts()
    const newCandidates = candidates.filter((c) => !c.existing)
    const added: KiroAccountConfig[] = []
    for (const candidate of newCandidates) {
      try {
        await this.store.writeAccountFile(candidate)
        added.push(candidate)
      } catch {
        // skip failed writes
      }
    }
    await this.rebuildRuntime(this.server?.running ?? false)
    return { added, skipped: candidates.length - added.length, status: await this.getStatus() }
  }

  async scanKiroAccounts(): Promise<{ candidates: any[] }> {
    await this.ensureReady()
    return this.store.scanKiroAccounts()
  }

  async importScannedAccounts(
    ids: string[]
  ): Promise<{ added: KiroAccountConfig[]; status: GatewayStatusSnapshot }> {
    await this.ensureReady()
    const { candidates } = await this.store.scanKiroAccounts()
    const selected = candidates.filter((c) => ids.includes(c.id) && !c.existing)
    const added: KiroAccountConfig[] = []
    for (const candidate of selected) {
      try {
        await this.store.writeAccountFile(candidate)
        added.push(candidate)
      } catch {
        // skip
      }
    }
    await this.rebuildRuntime(this.server?.running ?? false)
    return { added, status: await this.getStatus() }
  }

  async testKiroAccount(accountId: string): Promise<AccountTestResult> {
    await this.ensureReady()
    const result = await this.registry!.testAccount('kiro', accountId)
    await this.persistStateSoon()
    return result
  }

  async toggleKiroAccount(accountId: string, enabled: boolean): Promise<GatewayStatusSnapshot> {
    await this.ensureReady()
    await this.store.updateAccountFile(accountId, { enabled })
    await this.rebuildRuntime(this.server?.running ?? false)
    return this.getStatus()
  }

  async removeKiroAccount(accountId: string): Promise<GatewayStatusSnapshot> {
    await this.ensureReady()
    const deleted = await this.store.deleteAccountFile(accountId)
    if (!deleted) throw new Error(`Account not found: ${accountId}`)
    await this.rebuildRuntime(this.server?.running ?? false)
    return this.getStatus()
  }

  async listModels() {
    await this.ensureReady()
    return this.registry!.listModels()
  }

  async getAccountInfo(accountId: string) {
    await this.ensureReady()
    const info = await this.registry!.getAccountInfo('kiro', accountId)
    if (info.email) {
      this.store.updateAccountFile(accountId, { email: info.email }).catch(() => {})
    }
    return info
  }

  async resetKiroAccount(accountId: string): Promise<GatewayStatusSnapshot> {
    await this.ensureReady()
    await this.registry!.resetAccount('kiro', accountId)
    await this.persistStateSoon()
    return this.getStatus()
  }

  async setKiroAccountStatus(
    accountId: string,
    status: AccountStatus,
    reason?: string
  ): Promise<GatewayStatusSnapshot> {
    await this.ensureReady()
    await this.registry!.setAccountStatus('kiro', accountId, status, reason)
    await this.persistStateSoon()
    return this.getStatus()
  }

  async updateKiroSettings(settings: Partial<Record<string, any>>): Promise<GatewayStatusSnapshot> {
    await this.ensureReady()
    Object.assign(this.config!.providers.kiro.settings, settings)
    await this.store.saveConfig(this.config!)
    await this.rebuildRuntime(this.server?.running ?? false)
    return this.getStatus()
  }

  async updateKiroRouteName(routeName: string): Promise<GatewayStatusSnapshot> {
    return this.updateProviderRouteName('kiro', routeName)
  }

  async updateProviderRouteName(
    providerType: string,
    routeName: string
  ): Promise<GatewayStatusSnapshot> {
    await this.ensureReady()
    const name = routeName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
    if (!name) throw new Error('Invalid route name')
    const reserved = new Set(['v1', 'health', 'api'])
    if (reserved.has(name)) throw new Error(`Route name "${name}" is reserved`)
    const providers = this.config!.providers as Record<string, { routeName?: string } | undefined>
    const target = providers[providerType]
    if (!target) throw new Error(`Unknown provider: ${providerType}`)
    for (const [key, cfg] of Object.entries(providers)) {
      if (key === providerType) continue
      if ((cfg?.routeName || key) === name) {
        throw new Error(`Route name "${name}" is already used by provider "${key}"`)
      }
    }
    const currentRouteName = target.routeName || providerType
    if (name !== currentRouteName) {
      target.routeName = name
      await this.store.saveConfig(this.config!)
      await this.rebuildRuntime(this.server?.running ?? false)
    }
    return this.getStatus()
  }

  async getKiroSettings() {
    await this.ensureReady()
    return this.config!.providers.kiro.settings
  }

  async setPort(port: number): Promise<void> {
    await this.ensureReady()
    if (port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535')
    this.config!.server.port = port
    await this.store.saveConfig(this.config!)
    await this.rebuildRuntime(this.server?.running ?? false)
  }

  async setAutoStart(enabled: boolean): Promise<void> {
    await this.ensureReady()
    this.config!.server.autoStart = enabled
    await this.store.saveConfig(this.config!)
  }

  async getAutoStart(): Promise<boolean> {
    await this.ensureReady()
    return this.config!.server.autoStart ?? false
  }

  async clearLogs(): Promise<void> {
    this.logger.replace([])
    if (this.state) {
      this.state.providers.kiro.logs = []
      await this.store.saveState(this.state)
    }
  }

  async getLogs(options?: {
    category?: LogCategory
    requestId?: string
    level?: string
    limit?: number
  }): Promise<GatewayLogEntry[]> {
    return this.logger.getLogs(options)
  }

  async exportLogs(format: 'json' | 'ndjson'): Promise<string> {
    return this.logger.exportLogs(format)
  }

  getPricing(): Record<string, ModelPrice> {
    return this.pricing.list()
  }

  async readUsage(options?: {
    sinceKey?: string
    untilKey?: string
    accountId?: string
    model?: string
    provider?: string
  }) {
    await this.ensureReady()
    return this.usageStore!.read(options)
  }

  async clearUsage(): Promise<void> {
    await this.ensureReady()
    await this.usageStore!.clear()
  }

  async shutdown(): Promise<void> {
    if (this.server?.running) await this.server.stop()
    await this.logger.shutdown()
  }

  async generateNewApiKey(options: {
    name: string
    expiresAt?: number
    scopes?: string[]
  }): Promise<GatewayStatusSnapshot> {
    await this.ensureReady()
    const entry: ApiKeyEntry = {
      id: `key_${sha256Short(String(Date.now()) + Math.random(), 12)}`,
      key: generateApiKeyString(),
      name: options.name || 'Untitled',
      createdAt: Date.now(),
      expiresAt: options.expiresAt,
      scopes: options.scopes?.length ? options.scopes : undefined
    }
    this.config!.server.apiKeys.push(entry)
    await this.store.saveConfig(this.config!)
    if (this.server) this.server.updateConfig(this.config!)
    return this.getStatus()
  }

  async revokeApiKey(id: string): Promise<GatewayStatusSnapshot> {
    await this.ensureReady()
    const keys = this.config!.server.apiKeys
    const idx = keys.findIndex((e) => e.id === id)
    if (idx === -1) throw new Error('API key not found')
    keys.splice(idx, 1)
    this.lastUsedMap.delete(id)
    await this.store.saveConfig(this.config!)
    if (this.server) this.server.updateConfig(this.config!)
    return this.getStatus()
  }

  async updateApiKey(
    id: string,
    updates: { name?: string; expiresAt?: number | null; scopes?: string[] | null }
  ): Promise<GatewayStatusSnapshot> {
    await this.ensureReady()
    const entry = this.config!.server.apiKeys.find((e) => e.id === id)
    if (!entry) throw new Error('API key not found')
    if (updates.name !== undefined) entry.name = updates.name
    if (updates.expiresAt === null) delete entry.expiresAt
    else if (updates.expiresAt !== undefined) entry.expiresAt = updates.expiresAt
    if (updates.scopes === null) delete entry.scopes
    else if (updates.scopes !== undefined)
      entry.scopes = updates.scopes.length ? updates.scopes : undefined
    await this.store.saveConfig(this.config!)
    if (this.server) this.server.updateConfig(this.config!)
    return this.getStatus()
  }

  private touchApiKeyUsage(id: string): void {
    this.lastUsedMap.set(id, Date.now())
    if (!this.lastUsedFlushTimer) {
      this.lastUsedFlushTimer = setTimeout(() => this.flushLastUsed(), 60_000)
    }
  }

  private async flushLastUsed(): Promise<void> {
    this.lastUsedFlushTimer = undefined
    if (!this.config) return
    let changed = false
    for (const entry of this.config.server.apiKeys) {
      const ts = this.lastUsedMap.get(entry.id)
      if (ts && ts !== entry.lastUsedAt) {
        entry.lastUsedAt = ts
        changed = true
      }
    }
    if (changed) await this.store.saveConfig(this.config)
  }

  async updateProviderDisplayName(
    providerType: string,
    displayName: string
  ): Promise<GatewayStatusSnapshot> {
    await this.ensureReady()
    const providers = this.config!.providers as Record<string, { displayName?: string } | undefined>
    const target = providers[providerType]
    if (!target) throw new Error(`Unknown provider: ${providerType}`)
    target.displayName = displayName.trim() || undefined
    await this.store.saveConfig(this.config!)
    return this.getStatus()
  }

  async getModelMappings(): Promise<ModelMapping[]> {
    await this.ensureReady()
    return this.config!.modelMappings
  }

  async updateModelMappings(mappings: ModelMapping[]): Promise<GatewayStatusSnapshot> {
    await this.ensureReady()
    const sanitized = sanitizeModelMappings(mappings, this.kiroMappingProviders())
    if (Array.isArray(mappings) && sanitized.length !== mappings.length) {
      throw new Error(
        'Some mappings were rejected: alias must be non-empty, contain no whitespace or "/", and be unique'
      )
    }
    const validProviders = new Set<string>()
    for (const [key, cfg] of Object.entries(this.config!.providers) as Array<
      [string, { routeName?: string } | undefined]
    >) {
      validProviders.add(key)
      if (cfg?.routeName) validProviders.add(cfg.routeName)
    }
    for (const mapping of sanitized) {
      if (!validProviders.has(mapping.provider)) {
        throw new Error(
          `Mapping "${mapping.alias}" references unknown provider "${mapping.provider}"`
        )
      }
    }
    this.config!.modelMappings = sanitized
    await this.store.saveConfig(this.config!)
    await this.rebuildRuntime(this.server?.running ?? false)
    return this.getStatus()
  }

  private kiroMappingProviders(): Set<string> {
    const names = new Set<string>(['kiro'])
    const routeName = this.config?.providers.kiro.routeName
    if (routeName) names.add(routeName)
    return names
  }

  async addKiroRefreshToken(text: string): Promise<GatewayStatusSnapshot> {
    await this.ensureReady()
    const normalized = normalizeImportedAccount({ refreshToken: text.trim() })
    if (!normalized) throw new Error('Invalid refresh token')
    const vpn = this.config!.providers.kiro.settings.vpnProxyUrl
    const resolved = await resolveRefreshTokenAccount(normalized, vpn)
    const accountConfig = buildKiroAccountConfig(resolved)
    await this.store.writeAccountFile(accountConfig)
    await this.rebuildRuntime(this.server?.running ?? false)
    return this.getStatus()
  }

  async addKiroAccessToken(text: string): Promise<GatewayStatusSnapshot> {
    await this.ensureReady()
    const token = text.trim()
    if (!token) throw new Error('Invalid access token')
    const id = `kiro-access-${sha256Short(token)}`
    const accountConfig: KiroAccountConfig = {
      id,
      enabled: true,
      accessToken: token,
      label: `Access Token ${id.slice(-6)}`
    }
    await this.store.writeAccountFile(accountConfig)
    await this.rebuildRuntime(this.server?.running ?? false)
    return this.getStatus()
  }

  async importKiroJson(
    text: string
  ): Promise<{ added: number; skipped: number; errors: string[]; status: GatewayStatusSnapshot }> {
    await this.ensureReady()
    let items: any[]
    try {
      const parsed = JSON.parse(text.trim())
      items = Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      throw new Error('Invalid JSON input')
    }

    let added = 0,
      updated = 0,
      skipped = 0
    const errors: string[] = []
    const vpn = this.config!.providers.kiro.settings.vpnProxyUrl
    const existingAccounts = await this.store.readAccountFiles()
    const existingIds = new Set(existingAccounts.map((a) => a.id))

    for (const item of items) {
      const normalized = normalizeImportedAccount(item)
      if (!normalized) {
        skipped++
        continue
      }
      try {
        const resolved = await resolveRefreshTokenAccount(normalized, vpn)
        const accountConfig = buildKiroAccountConfig(resolved)
        if (existingIds.has(accountConfig.id)) {
          await this.store.updateAccountFile(accountConfig.id, {
            refreshToken: accountConfig.refreshToken,
            accessToken: accountConfig.accessToken,
            expiresAt: accountConfig.expiresAt,
            profileArn: accountConfig.profileArn,
            clientId: accountConfig.clientId,
            clientSecret: accountConfig.clientSecret,
            email: accountConfig.email,
            region: accountConfig.region,
            apiRegion: accountConfig.apiRegion
          })
          updated++
        } else {
          await this.store.writeAccountFile(accountConfig)
          existingIds.add(accountConfig.id)
          added++
        }
      } catch (err) {
        errors.push(toErrorMessage(err))
      }
    }

    if (added > 0 || updated > 0) {
      await this.rebuildRuntime(this.server?.running ?? false)
    }
    return { added, skipped: skipped + updated, errors, status: await this.getStatus() }
  }

  async detectKiroCli(customPath?: string): Promise<CliDetectResult> {
    return detectCli(customPath)
  }

  async loginWithKiroCli(options?: { cliPath?: string }): Promise<void> {
    loginCli(options)
  }

  async cancelKiroCliLogin(): Promise<boolean> {
    return cancelCli()
  }

  // ============== Codex ==============

  async scanCodexAccounts(): Promise<{ candidates: any[] }> {
    await this.ensureReady()
    return this.store.scanCodexAccounts()
  }

  async importScannedCodexAccounts(
    ids: string[]
  ): Promise<{ added: CodexAccountConfig[]; status: GatewayStatusSnapshot }> {
    await this.ensureReady()
    const { candidates } = await this.store.scanCodexAccounts()
    const selected = candidates.filter((c) => ids.includes(c.id) && !c.existing)
    const added: CodexAccountConfig[] = []
    for (const candidate of selected) {
      try {
        await this.store.writeCodexAccountFile(candidate)
        added.push(candidate)
      } catch {
        // skip
      }
    }
    if (added.length) await this.rebuildRuntime(this.server?.running ?? false)
    return { added, status: await this.getStatus() }
  }

  async testCodexAccount(accountId: string): Promise<AccountTestResult> {
    await this.ensureReady()
    const result = await this.registry!.testAccount('codex', accountId)
    await this.persistStateSoon()
    return result
  }

  async toggleCodexAccount(accountId: string, enabled: boolean): Promise<GatewayStatusSnapshot> {
    await this.ensureReady()
    await this.store.updateCodexAccountFile(accountId, { enabled })
    await this.rebuildRuntime(this.server?.running ?? false)
    return this.getStatus()
  }

  async removeCodexAccount(accountId: string): Promise<GatewayStatusSnapshot> {
    await this.ensureReady()
    const deleted = await this.store.deleteCodexAccountFile(accountId)
    if (!deleted) throw new Error(`Codex account not found: ${accountId}`)
    await this.rebuildRuntime(this.server?.running ?? false)
    return this.getStatus()
  }

  async getCodexAccountInfo(accountId: string) {
    await this.ensureReady()
    return this.registry!.getAccountInfo('codex', accountId)
  }

  async resetCodexAccount(accountId: string): Promise<GatewayStatusSnapshot> {
    await this.ensureReady()
    await this.registry!.resetAccount('codex', accountId)
    await this.persistStateSoon()
    return this.getStatus()
  }

  async setCodexAccountStatus(
    accountId: string,
    status: AccountStatus,
    reason?: string
  ): Promise<GatewayStatusSnapshot> {
    await this.ensureReady()
    await this.registry!.setAccountStatus('codex', accountId, status, reason)
    await this.persistStateSoon()
    return this.getStatus()
  }

  async getCodexSettings() {
    await this.ensureReady()
    return this.config!.providers.codex.settings
  }

  async updateCodexSettings(
    settings: Partial<Record<string, any>>
  ): Promise<GatewayStatusSnapshot> {
    await this.ensureReady()
    Object.assign(this.config!.providers.codex.settings, settings)
    await this.store.saveConfig(this.config!)
    await this.rebuildRuntime(this.server?.running ?? false)
    return this.getStatus()
  }

  /** 用户粘贴 ~/.codex/auth.json 内容（单对象或数组）批量导入 */
  async importCodexAuthJson(
    text: string
  ): Promise<{ added: number; skipped: number; errors: string[]; status: GatewayStatusSnapshot }> {
    await this.ensureReady()
    const trimmed = text.trim()
    if (!trimmed) throw new Error('Empty Codex auth.json input')
    try {
      JSON.parse(trimmed)
    } catch (err) {
      throw new Error(`Invalid JSON: ${toErrorMessage(err)}`)
    }
    const payloads = parseCodexAuthInput(trimmed)
    if (!payloads.length) {
      throw new Error(
        'No Codex credentials found in input. Expected ~/.codex/auth.json with `tokens.access_token` / `tokens.refresh_token`, or a codexdock export with `accounts[].credentials`.'
      )
    }
    let added = 0,
      updated = 0,
      skipped = 0
    const errors: string[] = []
    const existingAccounts = await this.store.readCodexAccountFiles()
    const existingIds = new Set(existingAccounts.map((a) => a.id))
    for (const payload of payloads) {
      try {
        const account = buildCodexAccountFromAuth(payload)
        if (!account) {
          skipped++
          continue
        }
        if (existingIds.has(account.id)) {
          await this.store.updateCodexAccountFile(account.id, {
            refreshToken: account.refreshToken,
            accessToken: account.accessToken,
            idToken: account.idToken,
            chatgptAccountId: account.chatgptAccountId,
            expiresAt: account.expiresAt,
            lastRefresh: account.lastRefresh,
            subscriptionActiveUntil: account.subscriptionActiveUntil,
            email: account.email,
            name: account.name
          })
          updated++
        } else {
          await this.store.writeCodexAccountFile(account)
          existingIds.add(account.id)
          added++
        }
      } catch (err) {
        errors.push(toErrorMessage(err))
      }
    }
    if (added > 0 || updated > 0) await this.rebuildRuntime(this.server?.running ?? false)
    return { added, skipped: skipped + updated, errors, status: await this.getStatus() }
  }

  /**
   * 启动 Codex OAuth 浏览器登录。
   * 进度通过 onLoginEvent 推送给 IPC（由调用方注入）。
   */
  async startCodexBrowserLogin(emit: LoginEventListener): Promise<void> {
    await this.ensureReady()
    return loginCodexWithBrowser(this.config!.providers.codex.settings, emit)
  }

  async startCodexDeviceLogin(emit: LoginEventListener): Promise<void> {
    await this.ensureReady()
    return loginCodexWithDevice(this.config!.providers.codex.settings, emit)
  }

  async cancelCodexLogin(): Promise<boolean> {
    const browser = await cancelCodexBrowserLogin()
    const device = await cancelCodexDeviceLogin()
    return browser || device
  }

  private ensureReady(): Promise<void> {
    return this.initialize()
  }

  private async rebuildRuntime(restartServer: boolean): Promise<void> {
    if (this.server?.running) await this.server.stop()
    const accountFiles = await this.store.readAccountFiles()
    const codexFiles = await this.store.readCodexAccountFiles()
    this.registry = new ProviderRegistry(
      this.config!,
      this.state!,
      this.logger,
      () => void this.persistStateSoon(),
      async (accountId, updates) => {
        try {
          await this.store.updateCodexAccountFile(accountId, updates)
        } catch (error) {
          this.logger.warn(`updateCodexAccountFile failed: ${toErrorMessage(error)}`, {
            category: 'system'
          })
        }
      }
    )
    await this.registry.initialize(accountFiles, codexFiles)
    this.server = new GatewayServer(
      this.config!,
      this.registry,
      this.logger,
      this.pricing,
      this.usageStore!
    )
    this.server.onApiKeyUsed = (id) => this.touchApiKeyUsage(id)
    if (restartServer) await this.server.start()
  }

  private async persistStateSoon(): Promise<void> {
    if (!this.state) return
    this.state.providers.kiro.logs = this.logger.getEntries()
    this.state.providers.codex.logs = this.logger.getEntries()
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      if (!this.state) return
      this.state.providers.kiro.logs = this.logger.getEntries()
      this.state.providers.codex.logs = this.logger.getEntries()
      void this.store.saveState(this.state)
    }, 100)
  }
}

export const gatewayHubService = new GatewayHubService()
