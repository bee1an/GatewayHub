import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

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
    getAccountInfo: (accountId: string) => ipcRenderer.invoke('gateway:getAccountInfo', accountId),
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
    updateModelMappings: (mappings: any) =>
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
      ipcRenderer.on('gateway:cliLoginOutput', (_e, data) => cb(data))
      return () => {
        ipcRenderer.removeAllListeners('gateway:cliLoginOutput')
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
    }
  },
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    install: () => ipcRenderer.invoke('updater:install'),
    onUpdateAvailable: (cb: (data: any) => void) => {
      ipcRenderer.on('updater:update-available', (_e, data) => cb(data))
      return () => ipcRenderer.removeAllListeners('updater:update-available')
    },
    onError: (cb: (message: string) => void) => {
      ipcRenderer.on('updater:error', (_e, message) => cb(message))
      return () => ipcRenderer.removeAllListeners('updater:error')
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
