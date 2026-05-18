import type { GatewayHubConfig, GatewayRequestContext, GatewayResponse, KiroAccountConfig, ProviderAdapter, ProviderModel, ProviderName, ProviderStatus } from './types'
import { GatewayLogger } from './core/logger'
import { KiroProvider } from './providers/kiro/provider'
import type { GatewayHubState } from './types'

class PlaceholderProvider implements ProviderAdapter {
  readonly name: ProviderName
  constructor(name: ProviderName, private readonly note: string) {
    this.name = name
  }
  async listModels(): Promise<ProviderModel[]> {
    return []
  }
  async chatCompletions(): Promise<GatewayResponse> {
    return { status: 501, headers: { 'content-type': 'application/json' }, body: { error: { message: this.note, type: 'not_implemented' } } }
  }
  async messages(): Promise<GatewayResponse> {
    return { status: 501, headers: { 'content-type': 'application/json' }, body: { error: { message: this.note, type: 'not_implemented' } } }
  }
  async getStatus(): Promise<ProviderStatus> {
    return { name: this.name, providerType: this.name, enabled: false, configured: false, status: 'placeholder', message: this.note, models: [] }
  }
}

export class ProviderRegistry {
  private readonly providers = new Map<ProviderName, ProviderAdapter>()
  private readonly routeNameToProvider = new Map<string, ProviderName>()

  constructor(
    private readonly config: GatewayHubConfig,
    private readonly state: GatewayHubState,
    private readonly logger: GatewayLogger,
    private readonly onStateChanged: () => void
  ) {}

  async initialize(accountFiles: KiroAccountConfig[]): Promise<void> {
    const kiroRouteName = this.config.providers.kiro.routeName || 'kiro'
    const kiro = new KiroProvider(this.config.providers.kiro, this.state.providers.kiro, this.logger, this.onStateChanged)
    await kiro.initialize(accountFiles)
    this.providers.set('kiro', kiro)
    this.routeNameToProvider.set(kiroRouteName, 'kiro')
    this.providers.set('codex', new PlaceholderProvider('codex', this.config.providers.codex.note))
    this.routeNameToProvider.set('codex', 'codex')
    this.providers.set('gemini', new PlaceholderProvider('gemini', this.config.providers.gemini.note))
    this.routeNameToProvider.set('gemini', 'gemini')
  }

  resolve(model?: string): { provider: ProviderAdapter; model: string; providerName: ProviderName } {
    const raw = model || ''
    if (raw.includes(':')) {
      throw new Error(`Invalid model format "${raw}". Use "provider/model" instead of colon notation.`)
    }
    const slash = raw.indexOf('/')
    const explicit = slash > 0 ? raw.slice(0, slash) : ''
    const resolvedProviderName = explicit ? this.routeNameToProvider.get(explicit) : undefined
    const providerName = resolvedProviderName || (explicit ? undefined : this.config.defaultProvider || 'kiro')
    if (!providerName) throw new Error(`Unknown provider: ${explicit}`)
    const provider = this.providers.get(providerName)
    if (!provider) throw new Error(`Unknown provider: ${providerName}`)
    return { provider, model: explicit ? raw.slice(slash + 1) : raw, providerName }
  }

  getRouteName(providerName: ProviderName): string {
    for (const [route, name] of this.routeNameToProvider) {
      if (name === providerName) return route
    }
    return providerName
  }

  async listModels(): Promise<ProviderModel[]> {
    const result: ProviderModel[] = []
    for (const [name, provider] of this.providers) {
      const models = await provider.listModels()
      const routeName = this.getRouteName(name)
      for (const model of models) {
        if (name === this.config.defaultProvider) result.push(model)
        result.push({ ...model, id: `${routeName}/${model.id}` })
      }
    }
    return dedupeModels(result)
  }

  async statuses(): Promise<ProviderStatus[]> {
    const result: ProviderStatus[] = []
    for (const [name, provider] of this.providers) {
      const routeName = this.getRouteName(name)
      if (provider.getStatus) {
        const s = await provider.getStatus()
        result.push({ ...s, name: routeName, providerType: name })
      } else {
        result.push({ name: routeName, providerType: name, enabled: true, configured: true, status: 'ready', models: [] })
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
    return { status: 501, headers: { 'content-type': 'application/json' }, body: { error: { message: 'count_tokens is not implemented for this provider' } } }
  }

  async testAccount(providerName: ProviderName, accountId: string) {
    const provider = this.providers.get(providerName)
    if (!provider?.testAccount) return { ok: false, accountId, message: `Provider ${providerName} cannot test accounts` }
    return provider.testAccount(accountId)
  }

  async getAccountInfo(providerName: ProviderName, accountId: string) {
    const provider = this.providers.get(providerName) as any
    if (!provider?.getAccountInfo) throw new Error(`Provider ${providerName} does not support getAccountInfo`)
    return provider.getAccountInfo(accountId)
  }

  async resetAccount(providerName: ProviderName, accountId: string) {
    const provider = this.providers.get(providerName) as any
    if (!provider?.resetAccount) throw new Error(`Provider ${providerName} does not support resetAccount`)
    return provider.resetAccount(accountId)
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
