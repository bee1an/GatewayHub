import type {
  AccountStatus,
  GptWebAccountConfig,
  CodexAccountConfig,
  GatewayHubConfig,
  GatewayRequestContext,
  GatewayResponse,
  GrokWebAccountConfig,
  GeminiWebAccountConfig,
  KiroAccountConfig,
  ModelMapping,
  NvidiaAccountConfig,
  OpenRouterAccountConfig,
  ProviderAdapter,
  ProviderModel,
  ProviderName,
  ProviderStatus,
  QoderAccountConfig,
  TraeAccountConfig,
  WindsurfAccountConfig
} from './types'
import { GatewayLogger } from './core/logger'
import { KiroProvider } from './providers/kiro/provider'
import { CodexProvider } from './providers/codex/provider'
import { WindsurfProvider } from './providers/windsurf/provider'
import { TraeProvider } from './providers/trae/provider'
import { OpenRouterProvider } from './providers/openrouter/provider'
import { NvidiaProvider } from './providers/nvidia/provider'
import { GptWebProvider } from './providers/gptWeb/provider'
import { GrokWebProvider } from './providers/grokWeb/provider'
import { GeminiWebProvider } from './providers/geminiWeb/provider'
import { QoderProvider } from './providers/qoder/provider'
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
    ) => Promise<void>,
    private readonly persistTraeAccount?: (
      accountId: string,
      updates: Partial<TraeAccountConfig>
    ) => Promise<void>,
    private readonly persistOpenRouterAccount?: (
      accountId: string,
      updates: Partial<OpenRouterAccountConfig>
    ) => Promise<void>,
    private readonly persistNvidiaAccount?: (
      accountId: string,
      updates: Partial<NvidiaAccountConfig>
    ) => Promise<void>,
    private readonly persistGeminiWebAccount?: (
      accountId: string,
      updates: Partial<GeminiWebAccountConfig>
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
    windsurfAccountFiles: WindsurfAccountConfig[] = [],
    traeAccountFiles: TraeAccountConfig[] = [],
    openrouterAccountFiles: OpenRouterAccountConfig[] = [],
    nvidiaAccountFiles: NvidiaAccountConfig[] = [],
    gptWebAccountFiles: GptWebAccountConfig[] = [],
    grokWebAccountFiles: GrokWebAccountConfig[] = [],
    qoderAccountFiles: QoderAccountConfig[] = [],
    geminiWebAccountFiles: GeminiWebAccountConfig[] = []
  ): Promise<void> {
    const p = this.config.providers
    const s = this.state.providers
    const log = this.logger
    const onChange = this.onStateChanged

    // Resolve runtime proxy URLs from the global server.proxyUrl + each provider's
    // useProxy toggle. Settings.vpnProxyUrl is a runtime-injected field; the disk
    // config only stores server.proxyUrl + useProxy and saveConfig strips this
    // value. Done before any provider initializes so token-refresh paths see the
    // resolved value.
    const globalProxyUrl = this.config.server.proxyUrl || ''
    const resolveProxy = (useProxy: boolean | undefined): string => (useProxy ? globalProxyUrl : '')
    p.kiro.settings.vpnProxyUrl = resolveProxy(p.kiro.useProxy)
    p.codex.settings.vpnProxyUrl = resolveProxy(p.codex.useProxy)
    p.windsurf.settings.vpnProxyUrl = resolveProxy(p.windsurf.useProxy)
    p.trae.settings.vpnProxyUrl = resolveProxy(p.trae.useProxy)
    p.gptWeb.settings.vpnProxyUrl = resolveProxy(p.gptWeb.useProxy)
    p.grokWeb.settings.vpnProxyUrl = resolveProxy(p.grokWeb.useProxy)
    p.qoder.settings.vpnProxyUrl = resolveProxy(p.qoder.useProxy)
    p.geminiWeb.settings.vpnProxyUrl = resolveProxy(p.geminiWeb.useProxy)

    await this.initProvider('kiro', new KiroProvider(p.kiro, s.kiro, log, onChange), accountFiles)

    await this.initProvider(
      'codex',
      new CodexProvider(p.codex, s.codex, log, onChange, this.persistCodexAccount),
      codexAccountFiles
    )
    await this.initProvider(
      'windsurf',
      new WindsurfProvider(p.windsurf, s.windsurf, log, onChange),
      windsurfAccountFiles
    )
    await this.initProvider(
      'trae',
      new TraeProvider(p.trae, s.trae, log, onChange, this.persistTraeAccount),
      traeAccountFiles
    )
    await this.initProvider(
      'openrouter',
      new OpenRouterProvider(
        p.openrouter,
        s.openrouter,
        log,
        onChange,
        this.persistOpenRouterAccount
      ),
      openrouterAccountFiles
    )
    await this.initProvider(
      'nvidia',
      new NvidiaProvider(p.nvidia, s.nvidia, log, onChange, this.persistNvidiaAccount),
      nvidiaAccountFiles
    )
    await this.initProvider(
      'gptWeb',
      new GptWebProvider(p.gptWeb, s.gptWeb, log, onChange),
      gptWebAccountFiles
    )
    await this.initProvider(
      'grokWeb',
      new GrokWebProvider(p.grokWeb, s.grokWeb, log, onChange),
      grokWebAccountFiles
    )
    await this.initProvider(
      'qoder',
      new QoderProvider(p.qoder, s.qoder, log, onChange),
      qoderAccountFiles
    )
    await this.initProvider(
      'geminiWeb',
      new GeminiWebProvider(p.geminiWeb, s.geminiWeb, log, onChange, this.persistGeminiWebAccount),
      geminiWebAccountFiles
    )

    this.registerProvider(
      'gemini',
      new PlaceholderProvider('gemini', p.gemini.note),
      p.gemini.routeName || 'gemini'
    )
  }

  private async initProvider(
    name: ProviderName,
    provider: ProviderAdapter & { initialize(files: any[]): Promise<void> },
    accountFiles: any[]
  ): Promise<void> {
    await provider.initialize(accountFiles)
    const cfg = (this.config.providers as Record<string, { routeName?: string }>)[name]
    this.registerProvider(name, provider, cfg?.routeName || name)
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
    const slash = raw.indexOf('/')
    if (raw.includes(':') && (slash < 0 || raw.indexOf(':') < slash)) {
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
    const proxyCapable = new Set([
      'kiro',
      'codex',
      'windsurf',
      'trae',
      'gptWeb',
      'grokWeb',
      'qoder',
      'geminiWeb'
    ])
    const result: ProviderStatus[] = []
    for (const [name, provider] of this.providers) {
      const routeName = this.getRouteName(name)
      const providerCfg = (this.config.providers as Record<string, any>)[name]
      const displayName = providerCfg?.displayName || undefined
      const useProxy = proxyCapable.has(name) ? !!providerCfg?.useProxy : undefined
      if (provider.getStatus) {
        const s = await provider.getStatus()
        result.push({ ...s, name: routeName, providerType: name, displayName, useProxy })
      } else {
        result.push({
          name: routeName,
          providerType: name,
          displayName,
          enabled: true,
          configured: true,
          status: 'ready',
          models: [],
          useProxy
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
    const provider = this.providers.get(providerName)
    if (!provider?.getAccountInfo)
      throw new Error(`Provider ${providerName} does not support getAccountInfo`)
    return provider.getAccountInfo(accountId)
  }

  async refreshAccountModels(providerName: ProviderName, accountId: string) {
    const provider = this.providers.get(providerName)
    if (!provider?.refreshAccountModels)
      throw new Error(`Provider ${providerName} does not support refreshAccountModels`)
    return provider.refreshAccountModels(accountId)
  }

  async resetAccount(providerName: ProviderName, accountId: string) {
    const provider = this.providers.get(providerName)
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
    const provider = this.providers.get(providerName)
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
