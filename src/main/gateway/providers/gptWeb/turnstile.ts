import type { GptWebAccountConfig, GptWebProviderSettings } from '../../types'
import type { SentinelPrepareResponse } from './types'

export interface BrowserSentinelData {
  cookieHeader?: string
  requirementsToken?: string
  proofToken?: string
  turnstileToken?: string
}

/**
 * GptWeb currently works with the browserless Sentinel requirements + PoW path.
 * Keep these exports as no-ops for compatibility with older callers/configs, but do
 * not spawn Chrome from the gateway request path.
 */
export async function getBrowserSentinelData(
  _account: GptWebAccountConfig,
  _settings: GptWebProviderSettings,
  _prepare?: SentinelPrepareResponse,
  _requirementsToken?: string
): Promise<BrowserSentinelData> {
  return {}
}

export async function getTurnstileToken(
  _account: GptWebAccountConfig,
  _settings: GptWebProviderSettings,
  _prepare?: SentinelPrepareResponse,
  _requirementsToken?: string
): Promise<string | undefined> {
  return undefined
}

export function invalidateTurnstileToken(_accountId: string): void {
  // no-op
}

export function disposeTurnstileBrowser(): void {
  // no-op: browserless implementation
}
