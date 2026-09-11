import { z } from 'zod'
import type { GatewayHubConfig, GatewayHubState } from './types'
import { modelMappingsSchema, portSchema, proxyUrlSchema } from './ipcSchemas'

const providerConfigSchema = z
  .object({
    enabled: z.boolean(),
    routeName: z.string().optional(),
    useProxy: z.boolean().optional(),
    settings: z.record(z.string(), z.unknown()).optional()
  })
  .passthrough()

export const gatewayHubConfigSchema = z
  .object({
    version: z.number().int().positive(),
    server: z
      .object({
        host: z.string().min(1),
        port: portSchema,
        proxyUrl: proxyUrlSchema.optional()
      })
      .passthrough(),
    defaultProvider: z.string().min(1),
    providers: z.record(z.string(), providerConfigSchema),
    modelMappings: modelMappingsSchema
  })
  .passthrough()

const providerStateSchema = z
  .object({
    accounts: z.record(z.string(), z.unknown()),
    currentAccountIndex: z.number().int().nonnegative(),
    logs: z.array(z.unknown())
  })
  .passthrough()

export const gatewayHubStateSchema = z
  .object({
    version: z.number().int().positive(),
    providers: z.record(z.string(), providerStateSchema)
  })
  .passthrough()

export function validateGatewayHubConfig(value: unknown): GatewayHubConfig {
  return gatewayHubConfigSchema.parse(value) as unknown as GatewayHubConfig
}

export function validateGatewayHubState(value: unknown): GatewayHubState {
  return gatewayHubStateSchema.parse(value) as unknown as GatewayHubState
}
