import { ElectronAPI } from '@electron-toolkit/preload'

export interface ModelMapping {
  alias: string
  provider: string
  model: string
  enabled: boolean
  note?: string
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      gateway: {
        status: () => Promise<any>
        start: () => Promise<any>
        stop: () => Promise<any>
        autoDiscoverKiro: () => Promise<any>
        scanKiroAccounts: () => Promise<{
          candidates: Array<{
            id: string
            label?: string
            email?: string
            refreshToken?: string
            profileArn?: string
            existing?: boolean
            sourceType?: string
          }>
        }>
        importScannedAccounts: (ids: string[]) => Promise<{ added: any[]; status: any }>
        testKiroAccount: (accountId: string) => Promise<any>
        toggleKiroAccount: (accountId: string, enabled: boolean) => Promise<any>
        removeKiroAccount: (accountId: string) => Promise<any>
        listModels: () => Promise<any>
        getAccountInfo: (accountId: string) => Promise<any>
        resetKiroAccount: (accountId: string) => Promise<any>
        setKiroAccountStatus: (accountId: string, status: string, reason?: string) => Promise<any>
        getKiroSettings: () => Promise<any>
        updateKiroSettings: (settings: Record<string, any>) => Promise<any>
        updateKiroRouteName: (routeName: string) => Promise<any>
        updateProviderRouteName: (providerType: string, routeName: string) => Promise<any>
        addKiroRefreshToken: (text: string) => Promise<any>
        addKiroAccessToken: (text: string) => Promise<any>
        importKiroJson: (
          text: string
        ) => Promise<{ added: number; skipped: number; errors: string[]; status: any }>
        detectKiroCli: (
          customPath?: string
        ) => Promise<{ found: boolean; path: string; version?: string }>
        loginWithKiroCli: (options?: { cliPath?: string }) => Promise<void>
        cancelKiroCliLogin: () => Promise<boolean>
        getModelMappings: () => Promise<ModelMapping[]>
        updateModelMappings: (mappings: ModelMapping[]) => Promise<any>
        generateApiKey: (options: {
          name: string
          expiresAt?: number
          scopes?: string[]
        }) => Promise<any>
        revokeApiKey: (id: string) => Promise<any>
        updateApiKey: (
          id: string,
          updates: { name?: string; expiresAt?: number | null; scopes?: string[] | null }
        ) => Promise<any>
        updateProviderDisplayName: (providerType: string, displayName: string) => Promise<any>
        getAutoStart: () => Promise<boolean>
        setAutoStart: (enabled: boolean) => Promise<void>
        clearLogs: () => Promise<void>
        getLogs: (options?: {
          category?: string
          requestId?: string
          level?: string
          limit?: number
        }) => Promise<any[]>
        exportLogs: (format: 'json' | 'ndjson') => Promise<string>
        onCliLoginOutput: (
          cb: (data: {
            type: string
            text?: string
            code?: number
            message?: string
            imported?: boolean
            error?: string
          }) => void
        ) => () => void
      }
    }
  }
}
