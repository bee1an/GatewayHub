export interface ModelMapping {
  alias: string
  provider: string
  model: string
  enabled: boolean
  note?: string
}

declare global {
  interface Window {
    api: {
      appVersion: string
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
        updateModelMappings: (
          mappings: { alias: string; provider: string; model: string }[]
        ) => Promise<any>
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
        getPricing: () => Promise<
          Record<
            string,
            {
              inputPerMTokens: number
              outputPerMTokens: number
              cacheReadPerMTokens?: number
              cacheWrite5mPerMTokens?: number
              cacheWrite1hPerMTokens?: number
            }
          >
        >
        readUsage: (options?: {
          sinceKey?: string
          untilKey?: string
          accountId?: string
          model?: string
          provider?: string
        }) => Promise<{
          summary: {
            todayTokens: number
            todayCredits: number
            todayCostUsd: number | null
            last30DaysTokens: number
            last30DaysCredits: number
            last30DaysCostUsd: number | null
            todayInputTokens: number
            todayOutputTokens: number
            todayCacheReadTokens: number
            todayCacheWriteTokens: number
            todayRequests: number
            updatedAt: string
          }
          daily: Array<{
            date: string
            accountId: string
            model: string
            provider?: string
            apiFormat?: 'openai' | 'anthropic'
            inputTokens: number
            outputTokens: number
            cacheReadTokens: number
            cacheWrite5mTokens: number
            cacheWrite1hTokens: number
            credits: number
            requests: number
            costUsd: number | null
            costBasis: 'credit' | 'token' | 'none'
            updatedAt: string
          }>
        }>
        clearUsage: () => Promise<void>
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
        // ========== Codex ==========
        scanCodexAccounts: () => Promise<{
          candidates: Array<{
            id: string
            label?: string
            email?: string
            chatgptAccountId?: string
            existing?: boolean
            sourceType?: string
          }>
        }>
        importScannedCodexAccounts: (ids: string[]) => Promise<{ added: any[]; status: any }>
        testCodexAccount: (accountId: string) => Promise<any>
        toggleCodexAccount: (accountId: string, enabled: boolean) => Promise<any>
        removeCodexAccount: (accountId: string) => Promise<any>
        getCodexAccountInfo: (accountId: string) => Promise<{
          id: string
          email?: string
          name?: string
          chatgptAccountId?: string
          subscriptionActiveUntil?: string
          expiresAt?: number
          lastRefresh?: string
        }>
        resetCodexAccount: (accountId: string) => Promise<any>
        setCodexAccountStatus: (accountId: string, status: string, reason?: string) => Promise<any>
        getCodexSettings: () => Promise<any>
        updateCodexSettings: (settings: Record<string, any>) => Promise<any>
        importCodexJson: (
          text: string
        ) => Promise<{ added: number; skipped: number; errors: string[]; status: any }>
        loginCodexBrowser: () => Promise<void>
        loginCodexDevice: () => Promise<void>
        cancelCodexLogin: () => Promise<boolean>
        onCodexLoginEvent: (
          cb: (event: {
            kind: 'pending' | 'authorize' | 'success' | 'error' | 'cancelled'
            message?: string
            authorizeUrl?: string
            userCode?: string
            verificationUri?: string
            accountId?: string
          }) => void
        ) => () => void
      }
      updater: {
        check: () => Promise<any>
        install: () => Promise<void>
        onUpdateAvailable: (
          cb: (data: {
            version: string
            releaseNotes: string | null
            releaseDate: string
            installMethod?: 'brew' | 'manual'
          }) => void
        ) => () => void
        onError: (cb: (message: string) => void) => () => void
      }
      upgrade: {
        onEvent: (
          cb: (
            event:
              | { kind: 'phase'; phase: 'download' | 'install' | 'success' | 'error' }
              | { kind: 'log'; text: string }
              | { kind: 'error'; message: string }
          ) => void
        ) => () => void
        notifyReady: () => void
        notifyInstallRendered: () => void
        openReleases: () => Promise<void>
        cancel: () => Promise<void>
        restart: () => Promise<void>
      }
    }
  }
}
