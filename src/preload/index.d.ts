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
            existingAccountId?: string
            updatable?: boolean
            sourceType?: string
          }>
        }>
        importScannedAccounts: (
          ids: string[]
        ) => Promise<{ added: any[]; updated?: number; status: any }>
        testKiroAccount: (accountId: string) => Promise<any>
        toggleKiroAccount: (accountId: string, enabled: boolean) => Promise<any>
        removeKiroAccount: (accountId: string) => Promise<any>
        listModels: () => Promise<any>
        getAccountInfo: (accountId: string) => Promise<any>
        refreshKiroAccountModels: (accountId: string) => Promise<any>
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
        setPort: (port: number) => Promise<void>
        setHost: (host: string) => Promise<void>
        getHost: () => Promise<string>
        getProxyUrl: () => Promise<string>
        setProxyUrl: (url: string) => Promise<any>
        setProviderUseProxy: (providerType: string, enabled: boolean) => Promise<any>
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
            gptWebAccountId?: string
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
          gptWebAccountId?: string
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
        // ========== Windsurf ==========
        scanWindsurfAccounts: () => Promise<{
          candidates: Array<{
            id: string
            label?: string
            email?: string
            existing?: boolean
            sourceType?: string
          }>
        }>
        importScannedWindsurfAccounts: (ids: string[]) => Promise<{ added: any[]; status: any }>
        importWindsurfJson: (
          text: string
        ) => Promise<{ added: number; skipped: number; errors: string[]; status: any }>
        addWindsurfApiKey: (text: string) => Promise<any>
        testWindsurfAccount: (accountId: string) => Promise<any>
        toggleWindsurfAccount: (accountId: string, enabled: boolean) => Promise<any>
        removeWindsurfAccount: (accountId: string) => Promise<any>
        getWindsurfAccountInfo: (accountId: string) => Promise<any>
        refreshWindsurfAccountModels: (accountId: string) => Promise<any>
        resetWindsurfAccount: (accountId: string) => Promise<any>
        setWindsurfAccountStatus: (
          accountId: string,
          status: string,
          reason?: string
        ) => Promise<any>
        getWindsurfSettings: () => Promise<any>
        updateWindsurfSettings: (settings: Record<string, any>) => Promise<any>
        // ========== Trae ==========
        scanTraeAccounts: () => Promise<{
          candidates: Array<{
            id: string
            email?: string
            label?: string
            countryCode?: string
            existing?: boolean
            sourceType?: string
          }>
        }>
        importScannedTraeAccounts: (ids: string[]) => Promise<{ added: any[]; status: any }>
        importTraeJson: (
          text: string
        ) => Promise<{ added: number; skipped: number; errors: string[]; status: any }>
        addTraeJwtToken: (text: string) => Promise<any>
        addTraeRefreshToken: (text: string) => Promise<any>
        testTraeAccount: (accountId: string) => Promise<any>
        toggleTraeAccount: (accountId: string, enabled: boolean) => Promise<any>
        removeTraeAccount: (accountId: string) => Promise<any>
        getTraeAccountInfo: (accountId: string) => Promise<any>
        refreshTraeAccountModels: (accountId: string) => Promise<any>
        resetTraeAccount: (accountId: string) => Promise<any>
        setTraeAccountStatus: (accountId: string, status: string, reason?: string) => Promise<any>
        getTraeSettings: () => Promise<any>
        updateTraeSettings: (settings: Record<string, any>) => Promise<any>
        // ========== OpenRouter ==========
        importOpenRouterJson: (
          text: string
        ) => Promise<{ added: number; skipped: number; errors: string[]; status: any }>
        addOpenRouterApiKey: (text: string) => Promise<any>
        testOpenRouterAccount: (accountId: string) => Promise<any>
        toggleOpenRouterAccount: (accountId: string, enabled: boolean) => Promise<any>
        removeOpenRouterAccount: (accountId: string) => Promise<any>
        getOpenRouterAccountInfo: (accountId: string) => Promise<any>
        refreshOpenRouterAccountModels: (accountId: string) => Promise<any>
        resetOpenRouterAccount: (accountId: string) => Promise<any>
        setOpenRouterAccountStatus: (
          accountId: string,
          status: string,
          reason?: string
        ) => Promise<any>
        getOpenRouterSettings: () => Promise<any>
        updateOpenRouterSettings: (settings: Record<string, any>) => Promise<any>
        // ========== NVIDIA ==========
        importNvidiaJson: (
          text: string
        ) => Promise<{ added: number; skipped: number; errors: string[]; status: any }>
        addNvidiaApiKey: (text: string) => Promise<any>
        testNvidiaAccount: (accountId: string) => Promise<any>
        toggleNvidiaAccount: (accountId: string, enabled: boolean) => Promise<any>
        removeNvidiaAccount: (accountId: string) => Promise<any>
        getNvidiaAccountInfo: (accountId: string) => Promise<any>
        refreshNvidiaAccountModels: (accountId: string) => Promise<any>
        resetNvidiaAccount: (accountId: string) => Promise<any>
        setNvidiaAccountStatus: (accountId: string, status: string, reason?: string) => Promise<any>
        getNvidiaSettings: () => Promise<any>
        updateNvidiaSettings: (settings: Record<string, any>) => Promise<any>
        // ========== GptWeb ==========
        importGptWebJson: (
          text: string
        ) => Promise<{ added: number; skipped: number; errors: string[]; status: any }>
        testGptWebAccount: (accountId: string) => Promise<any>
        toggleGptWebAccount: (accountId: string, enabled: boolean) => Promise<any>
        removeGptWebAccount: (accountId: string) => Promise<any>
        getGptWebAccountInfo: (accountId: string) => Promise<any>
        refreshGptWebAccountModels: (accountId: string) => Promise<any>
        resetGptWebAccount: (accountId: string) => Promise<any>
        setGptWebAccountStatus: (accountId: string, status: string, reason?: string) => Promise<any>
        getGptWebSettings: () => Promise<any>
        updateGptWebSettings: (settings: Record<string, any>) => Promise<any>
        // ========== Grok Web ==========
        importGrokWebJson: (
          text: string
        ) => Promise<{ added: number; skipped: number; errors: string[]; status: any }>
        testGrokWebAccount: (accountId: string) => Promise<any>
        toggleGrokWebAccount: (accountId: string, enabled: boolean) => Promise<any>
        removeGrokWebAccount: (accountId: string) => Promise<any>
        getGrokWebAccountInfo: (accountId: string) => Promise<any>
        refreshGrokWebAccountModels: (accountId: string) => Promise<any>
        resetGrokWebAccount: (accountId: string) => Promise<any>
        setGrokWebAccountStatus: (
          accountId: string,
          status: string,
          reason?: string
        ) => Promise<any>
        getGrokWebSettings: () => Promise<any>
        updateGrokWebSettings: (settings: Record<string, any>) => Promise<any>
        // ========== Qoder ==========
        addQoderPersonalAccessToken: (text: string) => Promise<any>
        addQoderCliLogin: (options?: { label?: string; qoderCliPath?: string }) => Promise<any>
        detectQoderCli: (customPath?: string) => Promise<any>
        loginWithQoderCli: (options?: { cliPath?: string; label?: string }) => Promise<any>
        cancelQoderCliLogin: () => Promise<boolean>
        importQoderJson: (
          text: string
        ) => Promise<{ added: number; skipped: number; errors: string[]; status: any }>
        testQoderAccount: (accountId: string) => Promise<any>
        toggleQoderAccount: (accountId: string, enabled: boolean) => Promise<any>
        removeQoderAccount: (accountId: string) => Promise<any>
        getQoderAccountInfo: (accountId: string) => Promise<any>
        refreshQoderAccountModels: (accountId: string) => Promise<any>
        resetQoderAccount: (accountId: string) => Promise<any>
        setQoderAccountStatus: (accountId: string, status: string, reason?: string) => Promise<any>
        getQoderSettings: () => Promise<any>
        updateQoderSettings: (settings: Record<string, any>) => Promise<any>
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
