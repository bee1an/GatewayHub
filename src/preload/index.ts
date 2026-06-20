import { contextBridge, ipcRenderer } from 'electron'

const appVersion: string = ipcRenderer.sendSync('app:version')

const api = {
  appVersion,
  gateway: {
    status: () => ipcRenderer.invoke('gateway:status'),
    start: () => ipcRenderer.invoke('gateway:start'),
    stop: () => ipcRenderer.invoke('gateway:stop'),
    autoDiscoverKiro: () => ipcRenderer.invoke('gateway:autoDiscoverKiro'),
    scanKiroAccounts: () => ipcRenderer.invoke('gateway:scanKiroAccounts'),
    importScannedAccounts: (ids: string[]) =>
      ipcRenderer.invoke('gateway:importScannedAccounts', ids),
    testKiroAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:testKiroAccount', accountId),
    toggleKiroAccount: (accountId: string, enabled: boolean) =>
      ipcRenderer.invoke('gateway:toggleKiroAccount', accountId, enabled),
    removeKiroAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:removeKiroAccount', accountId),
    listModels: () => ipcRenderer.invoke('gateway:listModels'),
    testRequest: (params: {
      url: string
      apiKey: string
      model: string
      prompt: string
      stream: boolean
    }) => ipcRenderer.invoke('gateway:testRequest', params),
    getAccountInfo: (accountId: string) => ipcRenderer.invoke('gateway:getAccountInfo', accountId),
    refreshKiroAccountModels: (accountId: string) =>
      ipcRenderer.invoke('gateway:refreshKiroAccountModels', accountId),
    resetKiroAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:resetKiroAccount', accountId),
    setKiroAccountStatus: (accountId: string, status: string, reason?: string) =>
      ipcRenderer.invoke('gateway:setKiroAccountStatus', accountId, status, reason),
    getKiroSettings: () => ipcRenderer.invoke('gateway:getKiroSettings'),
    updateKiroSettings: (settings: Record<string, any>) =>
      ipcRenderer.invoke('gateway:updateKiroSettings', settings),
    updateKiroRouteName: (routeName: string) =>
      ipcRenderer.invoke('gateway:updateKiroRouteName', routeName),
    updateProviderRouteName: (providerType: string, routeName: string) =>
      ipcRenderer.invoke('gateway:updateProviderRouteName', providerType, routeName),
    addKiroRefreshToken: (text: string) => ipcRenderer.invoke('gateway:addKiroRefreshToken', text),
    addKiroAccessToken: (text: string) => ipcRenderer.invoke('gateway:addKiroAccessToken', text),
    importKiroJson: (text: string) => ipcRenderer.invoke('gateway:importKiroJson', text),
    detectKiroCli: (customPath?: string) => ipcRenderer.invoke('gateway:detectKiroCli', customPath),
    loginWithKiroCli: (options?: { cliPath?: string }) =>
      ipcRenderer.invoke('gateway:loginWithKiroCli', options),
    cancelKiroCliLogin: () => ipcRenderer.invoke('gateway:cancelKiroCliLogin'),
    getModelMappings: () => ipcRenderer.invoke('gateway:getModelMappings'),
    updateModelMappings: (mappings: { alias: string; provider: string; model: string }[]) =>
      ipcRenderer.invoke('gateway:updateModelMappings', mappings),
    generateApiKey: (options: { name: string; expiresAt?: number; scopes?: string[] }) =>
      ipcRenderer.invoke('gateway:generateApiKey', options),
    revokeApiKey: (id: string) => ipcRenderer.invoke('gateway:revokeApiKey', id),
    updateApiKey: (
      id: string,
      updates: { name?: string; expiresAt?: number | null; scopes?: string[] | null }
    ) => ipcRenderer.invoke('gateway:updateApiKey', id, updates),
    updateProviderDisplayName: (providerType: string, displayName: string) =>
      ipcRenderer.invoke('gateway:updateProviderDisplayName', providerType, displayName),
    setPort: (port: number) => ipcRenderer.invoke('gateway:setPort', port),
    setHost: (host: string) => ipcRenderer.invoke('gateway:setHost', host),
    getHost: () => ipcRenderer.invoke('gateway:getHost'),
    getProxyUrl: () => ipcRenderer.invoke('gateway:getProxyUrl'),
    setProxyUrl: (url: string) => ipcRenderer.invoke('gateway:setProxyUrl', url),
    setProviderUseProxy: (providerType: string, enabled: boolean) =>
      ipcRenderer.invoke('gateway:setProviderUseProxy', providerType, enabled),
    getAutoStart: () => ipcRenderer.invoke('gateway:getAutoStart'),
    setAutoStart: (enabled: boolean) => ipcRenderer.invoke('gateway:setAutoStart', enabled),
    clearLogs: () => ipcRenderer.invoke('gateway:clearLogs'),
    getLogs: (options?: {
      category?: string
      requestId?: string
      level?: string
      limit?: number
    }) => ipcRenderer.invoke('gateway:getLogs', options),
    exportLogs: (format: 'json' | 'ndjson') => ipcRenderer.invoke('gateway:exportLogs', format),
    getPricing: () => ipcRenderer.invoke('gateway:getPricing'),
    readUsage: (options?: {
      sinceKey?: string
      untilKey?: string
      accountId?: string
      model?: string
      provider?: string
    }) => ipcRenderer.invoke('gateway:readUsage', options),
    clearUsage: () => ipcRenderer.invoke('gateway:clearUsage'),
    onCliLoginOutput: (cb: (data: any) => void) => {
      const listener = (_e: unknown, data: any): void => cb(data)
      ipcRenderer.on('gateway:cliLoginOutput', listener)
      return () => {
        ipcRenderer.removeListener('gateway:cliLoginOutput', listener)
      }
    },
    // ========== Codex ==========
    scanCodexAccounts: () => ipcRenderer.invoke('gateway:scanCodexAccounts'),
    importScannedCodexAccounts: (ids: string[]) =>
      ipcRenderer.invoke('gateway:importScannedCodexAccounts', ids),
    testCodexAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:testCodexAccount', accountId),
    toggleCodexAccount: (accountId: string, enabled: boolean) =>
      ipcRenderer.invoke('gateway:toggleCodexAccount', accountId, enabled),
    removeCodexAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:removeCodexAccount', accountId),
    getCodexAccountInfo: (accountId: string) =>
      ipcRenderer.invoke('gateway:getCodexAccountInfo', accountId),
    resetCodexAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:resetCodexAccount', accountId),
    setCodexAccountStatus: (accountId: string, status: string, reason?: string) =>
      ipcRenderer.invoke('gateway:setCodexAccountStatus', accountId, status, reason),
    getCodexSettings: () => ipcRenderer.invoke('gateway:getCodexSettings'),
    updateCodexSettings: (settings: Record<string, any>) =>
      ipcRenderer.invoke('gateway:updateCodexSettings', settings),
    importCodexJson: (text: string) => ipcRenderer.invoke('gateway:importCodexJson', text),
    loginCodexBrowser: () => ipcRenderer.invoke('gateway:loginCodexBrowser'),
    loginCodexDevice: () => ipcRenderer.invoke('gateway:loginCodexDevice'),
    cancelCodexLogin: () => ipcRenderer.invoke('gateway:cancelCodexLogin'),
    onCodexLoginEvent: (cb: (event: any) => void) => {
      const listener = (_e: unknown, data: any): void => cb(data)
      ipcRenderer.on('gateway:codexLoginEvent', listener)
      return () => {
        ipcRenderer.removeListener('gateway:codexLoginEvent', listener)
      }
    },
    // ========== Windsurf ==========
    scanWindsurfAccounts: () => ipcRenderer.invoke('gateway:scanWindsurfAccounts'),
    importScannedWindsurfAccounts: (ids: string[]) =>
      ipcRenderer.invoke('gateway:importScannedWindsurfAccounts', ids),
    importWindsurfJson: (text: string) => ipcRenderer.invoke('gateway:importWindsurfJson', text),
    addWindsurfApiKey: (text: string) => ipcRenderer.invoke('gateway:addWindsurfApiKey', text),
    testWindsurfAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:testWindsurfAccount', accountId),
    toggleWindsurfAccount: (accountId: string, enabled: boolean) =>
      ipcRenderer.invoke('gateway:toggleWindsurfAccount', accountId, enabled),
    removeWindsurfAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:removeWindsurfAccount', accountId),
    getWindsurfAccountInfo: (accountId: string) =>
      ipcRenderer.invoke('gateway:getWindsurfAccountInfo', accountId),
    refreshWindsurfAccountModels: (accountId: string) =>
      ipcRenderer.invoke('gateway:refreshWindsurfAccountModels', accountId),
    resetWindsurfAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:resetWindsurfAccount', accountId),
    setWindsurfAccountStatus: (accountId: string, status: string, reason?: string) =>
      ipcRenderer.invoke('gateway:setWindsurfAccountStatus', accountId, status, reason),
    getWindsurfSettings: () => ipcRenderer.invoke('gateway:getWindsurfSettings'),
    updateWindsurfSettings: (settings: Record<string, any>) =>
      ipcRenderer.invoke('gateway:updateWindsurfSettings', settings),
    // ========== Trae ==========
    scanTraeAccounts: () => ipcRenderer.invoke('gateway:scanTraeAccounts'),
    importScannedTraeAccounts: (ids: string[]) =>
      ipcRenderer.invoke('gateway:importScannedTraeAccounts', ids),
    importTraeJson: (text: string) => ipcRenderer.invoke('gateway:importTraeJson', text),
    addTraeJwtToken: (text: string) => ipcRenderer.invoke('gateway:addTraeJwtToken', text),
    addTraeRefreshToken: (text: string) => ipcRenderer.invoke('gateway:addTraeRefreshToken', text),
    testTraeAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:testTraeAccount', accountId),
    toggleTraeAccount: (accountId: string, enabled: boolean) =>
      ipcRenderer.invoke('gateway:toggleTraeAccount', accountId, enabled),
    removeTraeAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:removeTraeAccount', accountId),
    getTraeAccountInfo: (accountId: string) =>
      ipcRenderer.invoke('gateway:getTraeAccountInfo', accountId),
    refreshTraeAccountModels: (accountId: string) =>
      ipcRenderer.invoke('gateway:refreshTraeAccountModels', accountId),
    resetTraeAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:resetTraeAccount', accountId),
    setTraeAccountStatus: (accountId: string, status: string, reason?: string) =>
      ipcRenderer.invoke('gateway:setTraeAccountStatus', accountId, status, reason),
    getTraeSettings: () => ipcRenderer.invoke('gateway:getTraeSettings'),
    updateTraeSettings: (settings: Record<string, any>) =>
      ipcRenderer.invoke('gateway:updateTraeSettings', settings),
    // ========== OpenRouter ==========
    importOpenRouterJson: (text: string) =>
      ipcRenderer.invoke('gateway:importOpenRouterJson', text),
    addOpenRouterApiKey: (text: string) => ipcRenderer.invoke('gateway:addOpenRouterApiKey', text),
    testOpenRouterAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:testOpenRouterAccount', accountId),
    toggleOpenRouterAccount: (accountId: string, enabled: boolean) =>
      ipcRenderer.invoke('gateway:toggleOpenRouterAccount', accountId, enabled),
    removeOpenRouterAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:removeOpenRouterAccount', accountId),
    getOpenRouterAccountInfo: (accountId: string) =>
      ipcRenderer.invoke('gateway:getOpenRouterAccountInfo', accountId),
    refreshOpenRouterAccountModels: (accountId: string) =>
      ipcRenderer.invoke('gateway:refreshOpenRouterAccountModels', accountId),
    resetOpenRouterAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:resetOpenRouterAccount', accountId),
    setOpenRouterAccountStatus: (accountId: string, status: string, reason?: string) =>
      ipcRenderer.invoke('gateway:setOpenRouterAccountStatus', accountId, status, reason),
    getOpenRouterSettings: () => ipcRenderer.invoke('gateway:getOpenRouterSettings'),
    updateOpenRouterSettings: (settings: Record<string, any>) =>
      ipcRenderer.invoke('gateway:updateOpenRouterSettings', settings),
    // ========== NVIDIA ==========
    importNvidiaJson: (text: string) => ipcRenderer.invoke('gateway:importNvidiaJson', text),
    addNvidiaApiKey: (text: string) => ipcRenderer.invoke('gateway:addNvidiaApiKey', text),
    testNvidiaAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:testNvidiaAccount', accountId),
    toggleNvidiaAccount: (accountId: string, enabled: boolean) =>
      ipcRenderer.invoke('gateway:toggleNvidiaAccount', accountId, enabled),
    removeNvidiaAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:removeNvidiaAccount', accountId),
    getNvidiaAccountInfo: (accountId: string) =>
      ipcRenderer.invoke('gateway:getNvidiaAccountInfo', accountId),
    refreshNvidiaAccountModels: (accountId: string) =>
      ipcRenderer.invoke('gateway:refreshNvidiaAccountModels', accountId),
    resetNvidiaAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:resetNvidiaAccount', accountId),
    setNvidiaAccountStatus: (accountId: string, status: string, reason?: string) =>
      ipcRenderer.invoke('gateway:setNvidiaAccountStatus', accountId, status, reason),
    getNvidiaSettings: () => ipcRenderer.invoke('gateway:getNvidiaSettings'),
    updateNvidiaSettings: (settings: Record<string, any>) =>
      ipcRenderer.invoke('gateway:updateNvidiaSettings', settings),
    // ========== GptWeb ==========
    importGptWebJson: (text: string) => ipcRenderer.invoke('gateway:importGptWebJson', text),
    testGptWebAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:testGptWebAccount', accountId),
    toggleGptWebAccount: (accountId: string, enabled: boolean) =>
      ipcRenderer.invoke('gateway:toggleGptWebAccount', accountId, enabled),
    removeGptWebAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:removeGptWebAccount', accountId),
    getGptWebAccountInfo: (accountId: string) =>
      ipcRenderer.invoke('gateway:getGptWebAccountInfo', accountId),
    refreshGptWebAccountModels: (accountId: string) =>
      ipcRenderer.invoke('gateway:refreshGptWebAccountModels', accountId),
    resetGptWebAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:resetGptWebAccount', accountId),
    setGptWebAccountStatus: (accountId: string, status: string, reason?: string) =>
      ipcRenderer.invoke('gateway:setGptWebAccountStatus', accountId, status, reason),
    getGptWebSettings: () => ipcRenderer.invoke('gateway:getGptWebSettings'),
    updateGptWebSettings: (settings: Record<string, any>) =>
      ipcRenderer.invoke('gateway:updateGptWebSettings', settings),
    // ========== Grok Web ==========
    importGrokWebJson: (text: string) => ipcRenderer.invoke('gateway:importGrokWebJson', text),
    testGrokWebAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:testGrokWebAccount', accountId),
    toggleGrokWebAccount: (accountId: string, enabled: boolean) =>
      ipcRenderer.invoke('gateway:toggleGrokWebAccount', accountId, enabled),
    removeGrokWebAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:removeGrokWebAccount', accountId),
    getGrokWebAccountInfo: (accountId: string) =>
      ipcRenderer.invoke('gateway:getGrokWebAccountInfo', accountId),
    refreshGrokWebAccountModels: (accountId: string) =>
      ipcRenderer.invoke('gateway:refreshGrokWebAccountModels', accountId),
    resetGrokWebAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:resetGrokWebAccount', accountId),
    setGrokWebAccountStatus: (accountId: string, status: string, reason?: string) =>
      ipcRenderer.invoke('gateway:setGrokWebAccountStatus', accountId, status, reason),
    getGrokWebSettings: () => ipcRenderer.invoke('gateway:getGrokWebSettings'),
    updateGrokWebSettings: (settings: Record<string, any>) =>
      ipcRenderer.invoke('gateway:updateGrokWebSettings', settings),
    // ========== Gemini Web ==========
    importGeminiWebJson: (text: string) => ipcRenderer.invoke('gateway:importGeminiWebJson', text),
    testGeminiWebAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:testGeminiWebAccount', accountId),
    toggleGeminiWebAccount: (accountId: string, enabled: boolean) =>
      ipcRenderer.invoke('gateway:toggleGeminiWebAccount', accountId, enabled),
    removeGeminiWebAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:removeGeminiWebAccount', accountId),
    getGeminiWebAccountInfo: (accountId: string) =>
      ipcRenderer.invoke('gateway:getGeminiWebAccountInfo', accountId),
    refreshGeminiWebAccountModels: (accountId: string) =>
      ipcRenderer.invoke('gateway:refreshGeminiWebAccountModels', accountId),
    resetGeminiWebAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:resetGeminiWebAccount', accountId),
    setGeminiWebAccountStatus: (accountId: string, status: string, reason?: string) =>
      ipcRenderer.invoke('gateway:setGeminiWebAccountStatus', accountId, status, reason),
    getGeminiWebSettings: () => ipcRenderer.invoke('gateway:getGeminiWebSettings'),
    updateGeminiWebSettings: (settings: Record<string, any>) =>
      ipcRenderer.invoke('gateway:updateGeminiWebSettings', settings),
    // ========== Qoder ==========
    addQoderPersonalAccessToken: (text: string) =>
      ipcRenderer.invoke('gateway:addQoderPersonalAccessToken', text),
    addQoderCliLogin: (options?: { label?: string; qoderCliPath?: string }) =>
      ipcRenderer.invoke('gateway:addQoderCliLogin', options),
    detectQoderCli: (customPath?: string) =>
      ipcRenderer.invoke('gateway:detectQoderCli', customPath),
    loginWithQoderCli: (options?: { cliPath?: string; label?: string }) =>
      ipcRenderer.invoke('gateway:loginWithQoderCli', options),
    cancelQoderCliLogin: () => ipcRenderer.invoke('gateway:cancelQoderCliLogin'),
    importQoderJson: (text: string) => ipcRenderer.invoke('gateway:importQoderJson', text),
    testQoderAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:testQoderAccount', accountId),
    toggleQoderAccount: (accountId: string, enabled: boolean) =>
      ipcRenderer.invoke('gateway:toggleQoderAccount', accountId, enabled),
    removeQoderAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:removeQoderAccount', accountId),
    getQoderAccountInfo: (accountId: string) =>
      ipcRenderer.invoke('gateway:getQoderAccountInfo', accountId),
    refreshQoderAccountModels: (accountId: string) =>
      ipcRenderer.invoke('gateway:refreshQoderAccountModels', accountId),
    resetQoderAccount: (accountId: string) =>
      ipcRenderer.invoke('gateway:resetQoderAccount', accountId),
    setQoderAccountStatus: (accountId: string, status: string, reason?: string) =>
      ipcRenderer.invoke('gateway:setQoderAccountStatus', accountId, status, reason),
    getQoderSettings: () => ipcRenderer.invoke('gateway:getQoderSettings'),
    updateQoderSettings: (settings: Record<string, any>) =>
      ipcRenderer.invoke('gateway:updateQoderSettings', settings)
  },
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    install: () => ipcRenderer.invoke('updater:install'),
    onUpdateAvailable: (cb: (data: any) => void) => {
      const listener = (_e: unknown, data: any): void => cb(data)
      ipcRenderer.on('updater:update-available', listener)
      return () => ipcRenderer.removeListener('updater:update-available', listener)
    },
    onError: (cb: (message: string) => void) => {
      const listener = (_e: unknown, message: string): void => cb(message)
      ipcRenderer.on('updater:error', listener)
      return () => ipcRenderer.removeListener('updater:error', listener)
    }
  },
  upgrade: {
    onEvent: (cb: (event: any) => void) => {
      const listener = (_e: unknown, data: any): void => cb(data)
      ipcRenderer.on('upgrade:event', listener)
      return () => ipcRenderer.removeListener('upgrade:event', listener)
    },
    notifyReady: () => ipcRenderer.send('upgrade:ready'),
    notifyInstallRendered: () => ipcRenderer.send('upgrade:installRendered'),
    openReleases: () => ipcRenderer.invoke('upgrade:openReleases'),
    cancel: () => ipcRenderer.invoke('upgrade:cancel'),
    restart: () => ipcRenderer.invoke('upgrade:restart')
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
}
