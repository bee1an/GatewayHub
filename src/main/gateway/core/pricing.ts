import { readFile } from 'fs/promises'
import type { CostStats, ProviderName, UsageStats } from '../types'

export interface ModelPrice {
  inputPerMTokens: number
  outputPerMTokens: number
  cacheReadPerMTokens?: number
  cacheWrite5mPerMTokens?: number
  cacheWrite1hPerMTokens?: number
}

/** 网关原生计费单位（如 Kiro credit）→ USD 单价 */
export type CreditPriceMap = Record<ProviderName, number>

const BUILTIN_CREDIT_PRICES: CreditPriceMap = {
  // Kiro 订阅：Pro / Pro+ / Power 都是 0.02/credit；overage 0.04
  // 来源：https://kiro.dev/pricing
  kiro: 0.02
}

// 内置主流模型价格表（USD per 1M tokens）
// 数据来源：
// - https://claude.com/pricing
// - https://platform.openai.com/docs/pricing
// 价格变化时通过 ~/.config/gatewayhub/pricing.json 覆盖即可
const BUILTIN: Record<string, ModelPrice> = {
  // ---- Claude 4.x ----
  'claude-opus-4': {
    inputPerMTokens: 15,
    outputPerMTokens: 75,
    cacheReadPerMTokens: 1.5,
    cacheWrite5mPerMTokens: 18.75,
    cacheWrite1hPerMTokens: 30
  },
  'claude-opus-4-1': {
    inputPerMTokens: 15,
    outputPerMTokens: 75,
    cacheReadPerMTokens: 1.5,
    cacheWrite5mPerMTokens: 18.75,
    cacheWrite1hPerMTokens: 30
  },
  'claude-opus-4-5': {
    inputPerMTokens: 15,
    outputPerMTokens: 75,
    cacheReadPerMTokens: 1.5,
    cacheWrite5mPerMTokens: 18.75,
    cacheWrite1hPerMTokens: 30
  },
  'claude-opus-4-7': {
    inputPerMTokens: 15,
    outputPerMTokens: 75,
    cacheReadPerMTokens: 1.5,
    cacheWrite5mPerMTokens: 18.75,
    cacheWrite1hPerMTokens: 30
  },
  'claude-sonnet-4': {
    inputPerMTokens: 3,
    outputPerMTokens: 15,
    cacheReadPerMTokens: 0.3,
    cacheWrite5mPerMTokens: 3.75,
    cacheWrite1hPerMTokens: 6
  },
  'claude-sonnet-4-5': {
    inputPerMTokens: 3,
    outputPerMTokens: 15,
    cacheReadPerMTokens: 0.3,
    cacheWrite5mPerMTokens: 3.75,
    cacheWrite1hPerMTokens: 6
  },
  'claude-sonnet-4-6': {
    inputPerMTokens: 3,
    outputPerMTokens: 15,
    cacheReadPerMTokens: 0.3,
    cacheWrite5mPerMTokens: 3.75,
    cacheWrite1hPerMTokens: 6
  },
  'claude-haiku-4-5': {
    inputPerMTokens: 1,
    outputPerMTokens: 5,
    cacheReadPerMTokens: 0.1,
    cacheWrite5mPerMTokens: 1.25,
    cacheWrite1hPerMTokens: 2
  },
  // ---- Claude 3.x（旧版本）----
  'claude-3-5-sonnet': {
    inputPerMTokens: 3,
    outputPerMTokens: 15,
    cacheReadPerMTokens: 0.3,
    cacheWrite5mPerMTokens: 3.75
  },
  'claude-3-5-haiku': {
    inputPerMTokens: 0.8,
    outputPerMTokens: 4,
    cacheReadPerMTokens: 0.08,
    cacheWrite5mPerMTokens: 1
  },
  'claude-3-opus': {
    inputPerMTokens: 15,
    outputPerMTokens: 75,
    cacheReadPerMTokens: 1.5,
    cacheWrite5mPerMTokens: 18.75
  },
  // ---- OpenAI ----
  'gpt-5': {
    inputPerMTokens: 1.25,
    outputPerMTokens: 10,
    cacheReadPerMTokens: 0.125
  },
  'gpt-5-mini': {
    inputPerMTokens: 0.25,
    outputPerMTokens: 2,
    cacheReadPerMTokens: 0.025
  },
  'gpt-4.1': {
    inputPerMTokens: 2,
    outputPerMTokens: 8,
    cacheReadPerMTokens: 0.5
  },
  'gpt-4.1-mini': {
    inputPerMTokens: 0.4,
    outputPerMTokens: 1.6,
    cacheReadPerMTokens: 0.1
  },
  'gpt-4o': {
    inputPerMTokens: 2.5,
    outputPerMTokens: 10,
    cacheReadPerMTokens: 1.25
  },
  'gpt-4o-mini': {
    inputPerMTokens: 0.15,
    outputPerMTokens: 0.6,
    cacheReadPerMTokens: 0.075
  },
  'o4-mini': {
    inputPerMTokens: 1.1,
    outputPerMTokens: 4.4,
    cacheReadPerMTokens: 0.275
  },
  o3: {
    inputPerMTokens: 2,
    outputPerMTokens: 8,
    cacheReadPerMTokens: 0.5
  }
}

export const ZERO_COST: CostStats = {
  inputUsd: 0,
  outputUsd: 0,
  cacheReadUsd: 0,
  cacheWriteUsd: 0,
  creditsUsd: 0,
  totalUsd: 0,
  currency: 'USD',
  known: false,
  basis: 'none'
}

export interface PricingTableInit {
  modelOverrides?: Record<string, ModelPrice>
  creditOverrides?: CreditPriceMap
}

export class PricingTable {
  private prices: Record<string, ModelPrice>
  private credits: CreditPriceMap
  private resolveCache = new Map<string, ModelPrice | null>()

  constructor(init: Record<string, ModelPrice> | PricingTableInit = {}) {
    // 兼容旧签名：直接传 modelOverrides 对象
    const opts: PricingTableInit =
      'modelOverrides' in init || 'creditOverrides' in init
        ? (init as PricingTableInit)
        : { modelOverrides: init as Record<string, ModelPrice> }
    this.prices = { ...BUILTIN, ...(opts.modelOverrides ?? {}) }
    this.credits = { ...BUILTIN_CREDIT_PRICES, ...(opts.creditOverrides ?? {}) }
  }

  /** 列出当前价格表（含 builtin + override 合并后的结果），用于前端展示 */
  list(): Record<string, ModelPrice> {
    return { ...this.prices }
  }

  /** 列出当前 credit 单价表 */
  listCreditPrices(): CreditPriceMap {
    return { ...this.credits }
  }

  /** 取某个网关的 credit→USD 单价 */
  creditPrice(provider: ProviderName | undefined): number | undefined {
    if (!provider) return undefined
    return this.credits[provider]
  }

  /**
   * 解析模型 ID 到价格条目。
   * 1. 先精确匹配
   * 2. 失败则按 `-` 分段从右往左去掉日期/版本后缀重试
   *    e.g. claude-sonnet-4-5-20250920 → claude-sonnet-4-5 → claude-sonnet-4 → claude-sonnet
   * 3. 同时尝试剥离段内小数尾（claude-opus-4.7 → claude-opus-4），
   *    覆盖 Kiro 把版本号嵌在最后一段的情况
   * 4. 仍然失败返回 undefined
   */
  resolve(model: string | undefined): ModelPrice | undefined {
    if (!model) return undefined
    const normalized = normalizeModelKey(model)
    const cached = this.resolveCache.get(normalized)
    if (cached !== undefined) return cached ?? undefined

    const tryKey = (key: string): ModelPrice | undefined => this.prices[key]

    // 1. 精确匹配
    const exact = tryKey(normalized)
    if (exact) {
      this.resolveCache.set(normalized, exact)
      return exact
    }

    // 2. 段级回退 + 段内小数尾剥离
    const parts = normalized.split('-')
    for (let i = parts.length; i >= 1; i--) {
      const head = parts.slice(0, i).join('-')
      const candidates = [head, stripTrailingDecimal(head)]
      for (const candidate of candidates) {
        if (!candidate || candidate === normalized) continue
        const found = tryKey(candidate)
        if (found) {
          this.resolveCache.set(normalized, found)
          return found
        }
      }
    }

    this.resolveCache.set(normalized, null)
    return undefined
  }

  /**
   * 给定 model + usage 算出费用。
   * - 如果 provider 是 credit 网关（如 kiro）且 usage.credits 已知 → 按 credit×单价 计费
   * - 否则按 token 单价计费；找不到 model 价格条目返回全零
   */
  compute(
    model: string | undefined,
    usage: UsageStats | undefined,
    provider?: ProviderName
  ): CostStats {
    if (!usage) return { ...ZERO_COST }

    // 优先：按上游 credit 计费（Kiro 走这条路）
    const creditPrice = this.creditPrice(provider)
    if (creditPrice !== undefined && typeof usage.credits === 'number' && usage.credits > 0) {
      const creditsUsd = usage.credits * creditPrice
      return {
        inputUsd: 0,
        outputUsd: 0,
        cacheReadUsd: 0,
        cacheWriteUsd: 0,
        creditsUsd,
        totalUsd: creditsUsd,
        currency: 'USD',
        known: true,
        basis: 'credit'
      }
    }

    // 回退：按 token 单价计费
    const price = this.resolve(model)
    if (!price) return { ...ZERO_COST }

    const inputUsd = ((usage.inputTokens || 0) * price.inputPerMTokens) / 1e6
    const outputUsd = ((usage.outputTokens || 0) * price.outputPerMTokens) / 1e6
    const cacheReadUsd = ((usage.cacheReadTokens || 0) * (price.cacheReadPerMTokens ?? 0)) / 1e6
    const cacheWrite5mUsd =
      ((usage.cacheWrite5mTokens || 0) * (price.cacheWrite5mPerMTokens ?? 0)) / 1e6
    const cacheWrite1hUsd =
      ((usage.cacheWrite1hTokens || 0) * (price.cacheWrite1hPerMTokens ?? 0)) / 1e6
    const cacheWriteUsd = cacheWrite5mUsd + cacheWrite1hUsd

    return {
      inputUsd,
      outputUsd,
      cacheReadUsd,
      cacheWriteUsd,
      creditsUsd: 0,
      totalUsd: inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd,
      currency: 'USD',
      known: true,
      basis: 'token'
    }
  }
}

/** 暴露给其他模块用于规整模型 key（去 provider/ 前缀 + 小写） */
export { normalizeModelKey }

/**
 * 从 ~/.config/gatewayhub/pricing.json 异步加载用户覆盖。
 *
 * 文件结构：
 * ```json
 * {
 *   "claude-opus-4-7": { "inputPerMTokens": 15, "outputPerMTokens": 75 },
 *   "__credits__": { "kiro": 0.04 }   // 网关原生计费单位单价（USD/credit）
 * }
 * ```
 */
export async function loadPricingOverrides(filePath: string): Promise<PricingTableInit> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const modelOverrides: Record<string, ModelPrice> = {}
    let creditOverrides: CreditPriceMap | undefined
    for (const [key, value] of Object.entries(parsed)) {
      if (key === '__credits__') {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          creditOverrides = {}
          for (const [provider, price] of Object.entries(value as Record<string, unknown>)) {
            if (typeof price === 'number' && Number.isFinite(price) && price >= 0) {
              creditOverrides[provider] = price
            }
          }
        }
        continue
      }
      if (!value || typeof value !== 'object') continue
      const v = value as Partial<ModelPrice>
      if (typeof v.inputPerMTokens !== 'number' || typeof v.outputPerMTokens !== 'number') continue
      modelOverrides[normalizeModelKey(key)] = {
        inputPerMTokens: v.inputPerMTokens,
        outputPerMTokens: v.outputPerMTokens,
        cacheReadPerMTokens:
          typeof v.cacheReadPerMTokens === 'number' ? v.cacheReadPerMTokens : undefined,
        cacheWrite5mPerMTokens:
          typeof v.cacheWrite5mPerMTokens === 'number' ? v.cacheWrite5mPerMTokens : undefined,
        cacheWrite1hPerMTokens:
          typeof v.cacheWrite1hPerMTokens === 'number' ? v.cacheWrite1hPerMTokens : undefined
      }
    }
    return { modelOverrides, creditOverrides }
  } catch {
    return {}
  }
}

function normalizeModelKey(model: string): string {
  // 去掉 provider/ 前缀，统一小写
  const slash = model.indexOf('/')
  const trimmed = slash >= 0 ? model.slice(slash + 1) : model
  return trimmed.trim().toLowerCase()
}

/** claude-opus-4.7 → claude-opus-4；如果尾段没有小数则返回空串 */
function stripTrailingDecimal(key: string): string {
  const idx = key.lastIndexOf('-')
  if (idx === -1) return ''
  const last = key.slice(idx + 1)
  const dot = last.indexOf('.')
  if (dot === -1) return ''
  return `${key.slice(0, idx + 1)}${last.slice(0, dot)}`
}
