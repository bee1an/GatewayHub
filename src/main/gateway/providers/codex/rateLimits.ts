import type { CodexProviderSettings } from '../../types'
import { codexFetch, CodexAuthManager } from './auth'
import { codexUsageUrl } from './constants'
import type { CodexAccountRateLimits, CodexRateLimitWindow } from './types'

interface ApiWindow {
  used_percent?: number
  limit_window_seconds?: number | null
  reset_at?: number | null
  reset_after_seconds?: number | null
}

interface ApiPayload {
  plan_type?: string | null
  rate_limit?: { primary_window?: ApiWindow | null; secondary_window?: ApiWindow | null } | null
}

/**
 * 拉取 ChatGPT 后端的 codex 速率窗口信息（5h primary + weekly secondary）。
 * 失败抛错；调用方负责降级（不影响其它账号字段展示）。
 */
export async function fetchCodexRateLimits(
  auth: CodexAuthManager,
  settings: CodexProviderSettings
): Promise<CodexAccountRateLimits> {
  const token = await auth.getAccessToken()
  const url = codexUsageUrl(settings.baseUrl)
  const response = await codexFetch(
    url,
    {
      method: 'GET',
      headers: auth.buildHeaders(token),
      signal: AbortSignal.timeout(15_000)
    },
    settings.vpnProxyUrl
  )
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`GET ${url} failed (${response.status}): ${text.slice(0, 500)}`)
  }
  const payload = (await response.json()) as ApiPayload
  return {
    primary: mapWindow(payload.rate_limit?.primary_window),
    secondary: mapWindow(payload.rate_limit?.secondary_window),
    planType: payload.plan_type ?? undefined,
    fetchedAt: new Date().toISOString()
  }
}

function mapWindow(window?: ApiWindow | null): CodexRateLimitWindow | undefined {
  if (!window) return undefined
  const usedPercent = typeof window.used_percent === 'number' ? window.used_percent : 0
  const windowDurationMins =
    typeof window.limit_window_seconds === 'number' && window.limit_window_seconds > 0
      ? Math.ceil(window.limit_window_seconds / 60)
      : null
  let resetsAt: number | null = null
  if (typeof window.reset_at === 'number' && window.reset_at > 0) {
    // 上游可能给秒或毫秒，按数量级判断
    resetsAt = window.reset_at < 1e12 ? window.reset_at * 1000 : window.reset_at
  } else if (typeof window.reset_after_seconds === 'number' && window.reset_after_seconds > 0) {
    resetsAt = Date.now() + window.reset_after_seconds * 1000
  }
  return { usedPercent, windowDurationMins, resetsAt }
}
