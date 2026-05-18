import type {
  AccountStatus,
  AccountTestResult,
  GatewayHubConfig,
  GatewayHubState,
  GatewayStatusSnapshot,
  KiroAccountConfig,
  ProviderStatus
} from './types'
import { GatewayConfigStore } from './configStore'
import { GatewayLogger } from './core/logger'
import { ProviderRegistry } from './providerRegistry'
import { GatewayServer } from './server'
import { sha256Short, toErrorMessage } from './core/utils'
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

export class GatewayHubService {
  private readonly store = new GatewayConfigStore()
  private readonly logger = new GatewayLogger()
  private config?: GatewayHubConfig
  private state?: GatewayHubState
  private registry?: ProviderRegistry
  private server?: GatewayServer
  private saveTimer?: NodeJS.Timeout

  get configPath(): string {
    return this.store.configPath
  }

  get statePath(): string {
    return this.store.statePath
  }

  async initialize(): Promise<void> {
    await this.store.migrateIfNeeded()
    this.config = await this.store.loadConfig()
    this.state = await this.store.loadState()
    this.logger.replace(this.state.providers.kiro.logs ?? [])

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

    const accounts = await this.store.readAccountFiles()
    if (accounts.length === 0) {
      await this.autoDiscoverKiroAccounts()
    } else {
      await this.rebuildRuntime(false)
    }

    if (this.config.server.autoStart) await this.start()
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
    return {
      server: {
        running: this.server!.running,
        url: this.server!.url,
        host: this.config!.server.host,
        port: this.config!.server.port,
        apiKey: this.config!.server.apiKey
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
    return this.registry!.getAccountInfo('kiro', accountId)
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
    await this.ensureReady()
    const name = routeName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
    if (!name) throw new Error('Invalid route name')
    const reserved = new Set(['codex', 'gemini', 'v1', 'health', 'api'])
    if (reserved.has(name)) throw new Error(`Route name "${name}" is reserved`)
    const currentRouteName = this.config!.providers.kiro.routeName || 'kiro'
    if (name !== currentRouteName) {
      this.config!.providers.kiro.routeName = name
      await this.store.saveConfig(this.config!)
      await this.rebuildRuntime(this.server?.running ?? false)
    }
    return this.getStatus()
  }

  async getKiroSettings() {
    await this.ensureReady()
    return this.config!.providers.kiro.settings
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

  private async ensureReady(): Promise<void> {
    if (!this.config || !this.state || !this.registry || !this.server) await this.initialize()
  }

  private async rebuildRuntime(restartServer: boolean): Promise<void> {
    if (this.server?.running) await this.server.stop()
    const accountFiles = await this.store.readAccountFiles()
    this.registry = new ProviderRegistry(
      this.config!,
      this.state!,
      this.logger,
      () => void this.persistStateSoon()
    )
    await this.registry.initialize(accountFiles)
    this.server = new GatewayServer(this.config!, this.registry, this.logger)
    if (restartServer) await this.server.start()
  }

  private async persistStateSoon(): Promise<void> {
    if (!this.state) return
    this.state.providers.kiro.logs = this.logger.getEntries()
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      if (!this.state) return
      this.state.providers.kiro.logs = this.logger.getEntries()
      void this.store.saveState(this.state)
    }, 100)
  }
}

export const gatewayHubService = new GatewayHubService()
