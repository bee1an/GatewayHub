import type { TraeProviderSettings } from '../../types'
import { toErrorMessage } from '../../core/utils'

export async function traeFetch(
  url: string,
  init: RequestInit,
  settings?: Pick<TraeProviderSettings, 'vpnProxyUrl'>
): Promise<Response> {
  const proxyUrl = settings?.vpnProxyUrl
  if (!proxyUrl) return fetch(url, init)
  try {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string
    ) => Promise<any>
    const undici = await dynamicImport('undici')
    const proxy = proxyUrl.includes('://') ? proxyUrl : `http://${proxyUrl}`
    const dispatcher = new undici.ProxyAgent(proxy)
    return undici.fetch(url, { ...init, dispatcher }) as Promise<Response>
  } catch (error) {
    throw new Error(`Trae proxy setup failed for ${proxyUrl}: ${toErrorMessage(error)}`)
  }
}

export function joinUrl(base: string, path: string): string {
  const cleanBase = String(base || '').replace(/\/+$/, '')
  const cleanPath = String(path || '').startsWith('/') ? path : `/${path}`
  return `${cleanBase}${cleanPath}`
}
