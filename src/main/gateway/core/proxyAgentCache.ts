import { LRUCache } from 'lru-cache'
import { ProxyAgent } from 'undici'

export function createProxyAgentCache(options: { max?: number; ttl?: number } = {}) {
  const cache = new LRUCache<string, ProxyAgent>({
    max: options.max ?? 16,
    ttl: options.ttl ?? 30 * 60_000,
    updateAgeOnGet: true,
    dispose: (agent) => void agent.close()
  })

  return {
    get(proxyUrl: string): ProxyAgent {
      const normalized = proxyUrl.includes('://') ? proxyUrl : `http://${proxyUrl}`
      let agent = cache.get(normalized)
      if (!agent) {
        agent = new ProxyAgent(normalized)
        cache.set(normalized, agent)
      }
      return agent
    },
    clear(): void {
      cache.clear()
    }
  }
}
