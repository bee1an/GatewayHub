import { z } from 'zod'

const primitiveSchema = (value: unknown): z.ZodType => {
  if (typeof value === 'string') return z.string()
  if (typeof value === 'number') return z.number().finite()
  if (typeof value === 'boolean') return z.boolean()
  if (Array.isArray(value)) return z.array(z.unknown())
  return z.unknown()
}

/**
 * Builds a strict-by-key, partial settings schema from the provider defaults.
 * Unknown keys are stripped and known primitive fields keep their runtime type.
 * Provider normalizers remain responsible for domain-specific clamping.
 */
export function createSettingsPatchSchema<T extends object>(defaults: T): z.ZodType<Partial<T>> {
  const shape: Record<string, z.ZodType> = {}
  for (const [key, value] of Object.entries(defaults)) shape[key] = primitiveSchema(value)
  return z.object(shape).partial() as z.ZodType<Partial<T>>
}

export const accountStatusSchema = z.enum([
  'available',
  'cooling',
  'rate_limited',
  'quota_exceeded',
  'auth_failed',
  'manual_disabled'
])

export const portSchema = z.number().int().min(1).max(65_535)
export const hostSchema = z.string().trim().min(1).max(253)
export const booleanSchema = z.boolean()
export const stringSchema = z.string()
export const optionalStringSchema = z.string().optional()
export const nonEmptyStringSchema = z.string().trim().min(1)

export const proxyUrlSchema = z
  .string()
  .trim()
  .refine((value) => {
    if (!value || !value.includes('://')) return true
    try {
      return ['http:', 'https:', 'socks:', 'socks5:'].includes(new URL(value).protocol)
    } catch {
      return false
    }
  }, 'Proxy URL must use http, https, socks, or socks5')

export const modelMappingsSchema = z.array(
  z.object({
    alias: z.string(),
    provider: z.string(),
    model: z.string(),
    enabled: z.boolean(),
    note: z.string().optional()
  })
)

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(100),
  expiresAt: z.number().finite().positive().optional(),
  scopes: z.array(z.string().trim().min(1)).max(50).optional()
})

export const updateApiKeySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  expiresAt: z.number().finite().positive().nullable().optional(),
  scopes: z.array(z.string().trim().min(1)).max(50).nullable().optional()
})
