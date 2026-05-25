import { app } from 'electron'
import type { CodexProviderSettings } from '../../types'
import { codexFetch, CodexAuthManager } from './auth'
import { codexModelsUrl } from './constants'

/** ChatGPT 后端 /codex/models 单条模型条目（仅取我们需要的字段） */
interface ApiModel {
  slug?: string
  display_name?: string
  visibility?: string
  supported_in_api?: boolean
  priority?: number
}

interface ApiResponse {
  models?: ApiModel[]
}

/**
 * 上游会校验 client_version 必须是合法 semver（如 0.1.1）。
 * 优先用 electron 的 app.getVersion()；测试 / 非 electron 环境下回退到一个稳定的 0.0.0。
 */
function clientVersion(): string {
  try {
    return app?.getVersion?.() || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * 拉取 ChatGPT 后端的 codex 可用模型列表。
 *
 * 端点：GET <baseUrl>/codex/models?client_version=<semver>，鉴权头与 /codex/responses 相同。
 * 失败抛错；调用方负责降级（fallback 或保留旧缓存）。
 */
export async function fetchCodexModels(
  auth: CodexAuthManager,
  settings: CodexProviderSettings
): Promise<string[]> {
  const token = await auth.getAccessToken()
  const url = `${codexModelsUrl(settings.baseUrl)}?client_version=${encodeURIComponent(clientVersion())}`
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
  const payload = (await response.json()) as ApiResponse
  const models = payload.models ?? []
  // 只保留 supported_in_api && visibility=list；按 priority 升序，缺失视为最大值
  return models
    .filter((m) => m.slug && m.supported_in_api !== false && m.visibility !== 'hidden')
    .sort(
      (a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER)
    )
    .map((m) => m.slug as string)
}
