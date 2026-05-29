import type {
  AccountStatus,
  CodexAccountConfig,
  GatewayHubConfig,
  GatewayRequestContext,
  GatewayResponse,
  KiroAccountConfig,
  ModelMapping,
  ProviderAdapter,
  ProviderModel,
  ProviderName,
  ProviderStatus,
  WindsurfAccountConfig
} from './types'
import { GatewayLogger } from './core/logger'
import { KiroProvider } from './providers/kiro/provider'
import { CodexProvider } from './providers/codex/provider'
import { WindsurfProvider } from './providers/windsurf/provider'
import type { GatewayHubState } from './types'

class PlaceholderProvider implements ProviderAdapter {
  readonly name: ProviderName
  constructor(
    name: ProviderName,
    private readonly note: string
  ) {
    this.name = name
  }
  async listModels(): Promise<ProviderModel[]> {
    return []
  }
  async chatCompletions(): Promise<GatewayResponse> {
    return {
      status: 501,
      headers: { 'content-type': 'application/json' },
      body: { error: { message: this.note, type: 'not_implemented' } }
    }
  }
  async messages(): Promise<GatewayResponse> {
    return {
      status: 501,
      headers: { 'content-type': 'application/json' },
      body: { error: { message: this.note, type: 'not_implemented' } }
    }
  }
  async getStatus(): Promise<ProviderStatus> {
    return {
      name: this.name,
      providerType: this.name,
      enabled: false,
      configured: false,
      status: 'placeholder',
      message: this.note,
      models: []
    }
  }
}

export class ProviderRegistry {
  private readonly providers = new Map<ProviderName, ProviderAdapter>()
  private readonly routeNameToProvider = new Map<string, ProviderName>()
  private readonly aliasMap = new Map<string, ModelMapping>()

  constructor(
    private readonly config: GatewayHubConfig,
    private readonly state: GatewayHubState,
    private readonly logger: GatewayLogger,
    private readonly onStateChanged: () => void,
    private readonly persistCodexAccount?: (
      accountId: string,
      updates: Partial<CodexAccountConfig>
    ) => Promise<void>
  ) {
    for (const mapping of config.modelMappings ?? []) {
      if (!mapping.enabled) continue
      if (this.aliasMap.has(mapping.alias)) continue
      this.aliasMap.set(mapping.alias, mapping)
    }
  }

  async initialize(
    accountFiles: KiroAccountConfig[],
    codexAccountFiles: CodexAccountConfig[] = [],
    windsurfAccountFiles: WindsurfAccountConfig[] = []
  ): Promise<void> {
    const kiro = new KiroProvider(
      this.config.providers.kiro,
      this.state.providers.kiro,
      this.logger,
      this.onStateChanged
    )
    await kiro.initialize(accountFiles)
    this.registerProvider('kiro', kiro, this.config.providers.kiro.routeName || 'kiro')

    // Settings 页"代理"是全局字段（持久化在 kiro.settings.vpnProxyUrl 上），运行时同步给 codex
    this.config.providers.codex.settings.vpnProxyUrl =
      this.config.providers.kiro.settings.vpnProxyUrl

    const codex = new CodexProvider(
      this.config.providers.codex,
      this.state.providers.codex,
      this.logger,
      this.onStateChanged,
      this.persistCodexAccount
    )
    await codex.initialize(codexAccountFiles)
    this.registerProvider('codex', codex, this.config.providers.codex.routeName || 'codex')

    const windsurf = new WindsurfProvider(
      this.config.providers.windsurf,
      this.state.providers.windsurf,
      this.logger,
      this.onStateChanged
    )
    await windsurf.initialize(windsurfAccountFiles)
    this.registerProvider(
      'windsurf',
      windsurf,
      this.config.providers.windsurf.routeName || 'windsurf'
    )

    this.registerProvider(
      'gemini',
      new PlaceholderProvider('gemini', this.config.providers.gemini.note),
      this.config.providers.gemini.routeName || 'gemini'
    )
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.providers.values()].map((provider) => provider.dispose?.()))
  }

  private registerProvider(name: ProviderName, provider: ProviderAdapter, routeName: string): void {
    this.providers.set(name, provider)
    this.routeNameToProvider.set(routeName, name)
  }

  resolve(model?: string): {
    provider: ProviderAdapter
    model: string
    providerName: ProviderName
  } {
    const raw = model || ''
    if (raw.includes(':')) {
      throw new Error(
        `Invalid model format "${raw}". Use "provider/model" instead of colon notation.`
      )
    }
    const mapping = this.aliasMap.get(raw)
    if (mapping) {
      const target =
        this.providers.get(mapping.provider) ??
        this.providers.get(this.routeNameToProvider.get(mapping.provider) ?? '')
      if (!target) {
        throw new Error(`Model mapping "${raw}" targets unknown provider "${mapping.provider}"`)
      }
      return { provider: target, model: mapping.model, providerName: target.name }
    }
    const slash = raw.indexOf('/')
    if (slash <= 0) {
      throw new Error(
        `Model "${raw}" must be prefixed with a provider, e.g. "kiro/${raw || 'model-id'}"`
      )
    }
    const explicit = raw.slice(0, slash)
    const resolvedProviderName = this.routeNameToProvider.get(explicit)
    if (!resolvedProviderName) throw new Error(`Unknown provider: ${explicit}`)
    const provider = this.providers.get(resolvedProviderName)
    if (!provider) throw new Error(`Unknown provider: ${resolvedProviderName}`)
    return { provider, model: raw.slice(slash + 1), providerName: resolvedProviderName }
  }

  getRouteName(providerName: ProviderName): string {
    for (const [route, name] of this.routeNameToProvider) {
      if (name === providerName) return route
    }
    return providerName
  }

  async listModels(): Promise<ProviderModel[]> {
    const result: ProviderModel[] = []
    const mappedOriginals = new Set<string>()

    for (const mapping of this.aliasMap.values()) {
      const routeName = this.getRouteName(mapping.provider)
      result.push({
        id: mapping.alias,
        provider: mapping.provider,
        ownedBy: routeName,
        description: mapping.note || `→ ${routeName}/${mapping.model}`
      })
      mappedOriginals.add(`${routeName}/${mapping.model}`)
    }

    for (const [name, provider] of this.providers) {
      const models = await provider.listModels()
      const routeName = this.getRouteName(name)
      for (const model of models) {
        const fullId = `${routeName}/${model.id}`
        if (mappedOriginals.has(fullId)) continue
        result.push({ ...model, id: fullId, ownedBy: routeName })
      }
    }
    return dedupeModels(result)
  }

  async statuses(): Promise<ProviderStatus[]> {
    const result: ProviderStatus[] = []
    for (const [name, provider] of this.providers) {
      const routeName = this.getRouteName(name)
      const providerCfg = (this.config.providers as Record<string, any>)[name]
      const displayName = providerCfg?.displayName || undefined
      if (provider.getStatus) {
        const s = await provider.getStatus()
        result.push({ ...s, name: routeName, providerType: name, displayName })
      } else {
        result.push({
          name: routeName,
          providerType: name,
          displayName,
          enabled: true,
          configured: true,
          status: 'ready',
          models: []
        })
      }
    }
    return result
  }

  async chatCompletions(body: any, context: GatewayRequestContext): Promise<GatewayResponse> {
    const { provider, model } = this.resolve(body.model)
    return provider.chatCompletions({ ...body, model }, context)
  }

  async messages(body: any, context: GatewayRequestContext): Promise<GatewayResponse> {
    const { provider, model } = this.resolve(body.model)
    return provider.messages({ ...body, model }, context)
  }

  async countTokens(body: any, context: GatewayRequestContext): Promise<GatewayResponse> {
    const { provider, model } = this.resolve(body.model)
    if (provider.countTokens) return provider.countTokens({ ...body, model }, context)
    return {
      status: 501,
      headers: { 'content-type': 'application/json' },
      body: { error: { message: 'count_tokens is not implemented for this provider' } }
    }
  }

  async testAccount(providerName: ProviderName, accountId: string) {
    const provider = this.providers.get(providerName)
    if (!provider?.testAccount)
      return { ok: false, accountId, message: `Provider ${providerName} cannot test accounts` }
    return provider.testAccount(accountId)
  }

  async getAccountInfo(providerName: ProviderName, accountId: string) {
    const provider = this.providers.get(providerName) as any
    if (!provider?.getAccountInfo)
      throw new Error(`Provider ${providerName} does not support getAccountInfo`)
    return provider.getAccountInfo(accountId)
  }

  async refreshAccountModels(providerName: ProviderName, accountId: string) {
    const provider = this.providers.get(providerName) as any
    if (!provider?.refreshAccountModels)
      throw new Error(`Provider ${providerName} does not support refreshAccountModels`)
    return provider.refreshAccountModels(accountId)
  }

  async resetAccount(providerName: ProviderName, accountId: string) {
    const provider = this.providers.get(providerName) as any
    if (!provider?.resetAccount)
      throw new Error(`Provider ${providerName} does not support resetAccount`)
    return provider.resetAccount(accountId)
  }

  async setAccountStatus(
    providerName: ProviderName,
    accountId: string,
    status: AccountStatus,
    reason?: string
  ) {
    const provider = this.providers.get(providerName) as any
    if (!provider?.setAccountStatus)
      throw new Error(`Provider ${providerName} does not support setAccountStatus`)
    return provider.setAccountStatus(accountId, status, reason)
  }
}

function dedupeModels(models: ProviderModel[]): ProviderModel[] {
  const seen = new Set<string>()
  const out: ProviderModel[] = []
  for (const model of models) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    out.push(model)
  }
  return out
}
