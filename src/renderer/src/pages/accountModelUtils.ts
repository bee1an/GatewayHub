import type { AccountModel } from './gatewayDetailTypes'

export function normalizeAccountModels(models: unknown): AccountModel[] {
  if (!Array.isArray(models)) return []
  const normalized: AccountModel[] = []
  const seen = new Set<string>()

  for (const item of models) {
    const model = normalizeAccountModel(item)
    if (!model || seen.has(model.modelId)) continue
    normalized.push(model)
    seen.add(model.modelId)
  }

  return normalized
}

function normalizeAccountModel(item: unknown): AccountModel | undefined {
  if (typeof item === 'string') {
    const id = item.trim()
    if (!id) return undefined
    return {
      modelId: id,
      modelName: id,
      rateMultiplier: 1,
      rateUnit: 'request'
    }
  }

  if (!item || typeof item !== 'object') return undefined
  const raw = item as Partial<AccountModel>
  const id = String(raw.modelId || raw.modelName || '').trim()
  if (!id) return undefined

  return {
    modelId: id,
    modelName: String(raw.modelName || id),
    rateMultiplier:
      typeof raw.rateMultiplier === 'number' && Number.isFinite(raw.rateMultiplier)
        ? raw.rateMultiplier
        : 1,
    rateUnit: raw.rateUnit || 'request'
  }
}
