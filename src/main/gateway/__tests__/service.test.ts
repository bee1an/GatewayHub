import { describe, expect, it, vi } from 'vitest'
import { GatewayHubService } from '../service'

describe('GatewayHubService stop lifecycle', () => {
  it('flushes delayed api-key and state writes so one-shot CLI processes can exit', async () => {
    const service = new GatewayHubService()
    const serviceAny = service as any
    const store = {
      saveConfig: vi.fn().mockResolvedValue(undefined),
      saveState: vi.fn().mockResolvedValue(undefined)
    }
    const server = {
      running: true,
      url: 'http://127.0.0.1:0',
      stop: vi.fn(async () => {
        server.running = false
      })
    }
    const registry = {
      dispose: vi.fn().mockResolvedValue(undefined),
      statuses: vi.fn().mockResolvedValue([])
    }

    serviceAny.store = store
    serviceAny.server = server
    serviceAny.registry = registry
    serviceAny.initPromise = Promise.resolve()
    serviceAny.config = {
      server: {
        host: '127.0.0.1',
        port: 0,
        apiKeys: [{ id: 'key-1', keyHash: 'hash', name: 'test', createdAt: 0 }]
      }
    }
    serviceAny.state = {
      providers: {
        kiro: { logs: [] },
        codex: { logs: [] },
        windsurf: { logs: [] },
        trae: { logs: [] },
        openrouter: { logs: [] }
      }
    }

    try {
      serviceAny.touchApiKeyUsage('key-1')
      await serviceAny.persistStateSoon()
      expect(serviceAny.lastUsedFlushTimer).toBeTruthy()
      expect(serviceAny.saveTimer).toBeTruthy()

      await service.stop()

      expect(server.stop).toHaveBeenCalledOnce()
      expect(registry.dispose).toHaveBeenCalledOnce()
      expect(serviceAny.lastUsedFlushTimer).toBeUndefined()
      expect(serviceAny.saveTimer).toBeUndefined()
      expect(serviceAny.config.server.apiKeys[0].lastUsedAt).toEqual(expect.any(Number))
      expect(store.saveConfig).toHaveBeenCalledOnce()
      expect(store.saveState).toHaveBeenCalledOnce()
    } finally {
      if (serviceAny.lastUsedFlushTimer) clearTimeout(serviceAny.lastUsedFlushTimer)
      if (serviceAny.saveTimer) clearTimeout(serviceAny.saveTimer)
    }
  })
})

describe('GatewayHubService API-key provider imports', () => {
  it('validates OpenRouter keys immediately so import-key returns a ready account', async () => {
    const service = new GatewayHubService()
    const serviceAny = service as any
    const testAccount = vi.fn().mockResolvedValue({
      ok: true,
      accountId: 'openrouter-id',
      message: 'ok'
    })

    serviceAny.initPromise = Promise.resolve()
    serviceAny.store = {
      writeOpenRouterAccountFile: vi.fn().mockResolvedValue('/tmp/openrouter.json'),
      deleteOpenRouterAccountFile: vi.fn()
    }
    serviceAny.rebuildRuntime = vi.fn().mockResolvedValue(undefined)
    serviceAny.registry = { testAccount }
    serviceAny.persistStateSoon = vi.fn().mockResolvedValue(undefined)
    serviceAny.getStatus = vi.fn().mockResolvedValue({ providers: [] })

    await service.addOpenRouterApiKey('sk-or-v1-test')

    expect(serviceAny.store.writeOpenRouterAccountFile).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-or-v1-test' })
    )
    expect(testAccount).toHaveBeenCalledWith('openrouter', expect.stringMatching(/^openrouter-/))
    expect(serviceAny.store.deleteOpenRouterAccountFile).not.toHaveBeenCalled()
  })

  it('removes an invalid NVIDIA key when the immediate validation fails', async () => {
    const service = new GatewayHubService()
    const serviceAny = service as any
    const testAccount = vi.fn().mockResolvedValue({
      ok: false,
      accountId: 'nvidia-id',
      message: 'Authorization failed'
    })

    serviceAny.initPromise = Promise.resolve()
    serviceAny.store = {
      writeNvidiaAccountFile: vi.fn().mockResolvedValue('/tmp/nvidia.json'),
      deleteNvidiaAccountFile: vi.fn().mockResolvedValue(true)
    }
    serviceAny.rebuildRuntime = vi.fn().mockResolvedValue(undefined)
    serviceAny.registry = { testAccount }
    serviceAny.persistStateSoon = vi.fn().mockResolvedValue(undefined)

    await expect(service.addNvidiaApiKey('nvapi-bad')).rejects.toThrow('Authorization failed')

    expect(serviceAny.store.writeNvidiaAccountFile).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'nvapi-bad' })
    )
    expect(testAccount).toHaveBeenCalledWith('nvidia', expect.stringMatching(/^nvidia-/))
    expect(serviceAny.store.deleteNvidiaAccountFile).toHaveBeenCalledWith(
      expect.stringMatching(/^nvidia-/)
    )
    expect(serviceAny.rebuildRuntime).toHaveBeenCalledTimes(2)
  })
})

describe('GatewayHubService API-key provider settings', () => {
  it('clamps OpenRouter and NVIDIA request race concurrency to 2..6 on save', async () => {
    const service = new GatewayHubService()
    const serviceAny = service as any
    serviceAny.initPromise = Promise.resolve()
    serviceAny.store = { saveConfig: vi.fn().mockResolvedValue(undefined) }
    serviceAny.rebuildRuntime = vi.fn().mockResolvedValue(undefined)
    serviceAny.getStatus = vi.fn().mockResolvedValue({ providers: [] })
    serviceAny.config = {
      providers: {
        openrouter: {
          settings: {
            baseUrl: 'https://openrouter.test',
            firstTokenTimeoutSeconds: 120,
            streamingReadTimeoutSeconds: 300,
            maxRetries: 2,
            requestRaceEnabled: false,
            requestRaceMaxConcurrent: 3
          }
        },
        nvidia: {
          settings: {
            baseUrl: 'https://nvidia.test',
            firstTokenTimeoutSeconds: 120,
            streamingReadTimeoutSeconds: 300,
            maxRetries: 2,
            requestRaceEnabled: false,
            requestRaceMaxConcurrent: 3
          }
        }
      }
    }

    await service.updateOpenRouterSettings({
      requestRaceEnabled: true,
      requestRaceMaxConcurrent: 99
    })
    await service.updateNvidiaSettings({
      requestRaceEnabled: true,
      requestRaceMaxConcurrent: 1
    })

    expect(serviceAny.config.providers.openrouter.settings.requestRaceEnabled).toBe(true)
    expect(serviceAny.config.providers.openrouter.settings.requestRaceMaxConcurrent).toBe(6)
    expect(serviceAny.config.providers.nvidia.settings.requestRaceEnabled).toBe(true)
    expect(serviceAny.config.providers.nvidia.settings.requestRaceMaxConcurrent).toBe(2)
  })
})

describe('GatewayHubService Kiro scanned imports', () => {
  it('updates existing Kiro accounts when scanned credentials are richer', async () => {
    const service = new GatewayHubService()
    const serviceAny = service as any

    serviceAny.initPromise = Promise.resolve()
    serviceAny.store = {
      scanKiroAccounts: vi.fn().mockResolvedValue({
        candidates: [
          {
            id: 'kiro-refresh-candidate',
            existing: true,
            existingAccountId: 'kiro-refresh-existing',
            updatable: true,
            enabled: true,
            refreshToken: 'refresh-token',
            clientId: 'client-id',
            clientSecret: 'client-secret',
            region: 'us-east-1',
            sourceType: 'account-manager'
          }
        ]
      }),
      updateAccountFile: vi.fn().mockResolvedValue(undefined),
      writeAccountFile: vi.fn()
    }
    serviceAny.rebuildRuntime = vi.fn().mockResolvedValue(undefined)
    serviceAny.getStatus = vi.fn().mockResolvedValue({ providers: [] })

    const result = await service.importScannedAccounts(['kiro-refresh-candidate'])

    expect(serviceAny.store.updateAccountFile).toHaveBeenCalledWith('kiro-refresh-existing', {
      refreshToken: 'refresh-token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      region: 'us-east-1'
    })
    expect(serviceAny.store.writeAccountFile).not.toHaveBeenCalled()
    expect(serviceAny.rebuildRuntime).toHaveBeenCalledOnce()
    expect(result.updated).toBe(1)
  })
})
