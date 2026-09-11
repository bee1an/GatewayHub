import { z } from 'zod'
import type { BaseAccountConfig } from './types'

export const baseAccountSchema = z
  .object({
    id: z.string().trim().min(1),
    label: z.string().optional(),
    email: z.string().optional(),
    enabled: z.boolean(),
    path: z.string().optional()
  })
  .passthrough()

export function validateAccount<T extends BaseAccountConfig>(value: T): T {
  return baseAccountSchema.parse(value) as T
}
