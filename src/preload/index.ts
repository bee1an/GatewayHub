import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  gateway: {
    status: () => ipcRenderer.invoke('gateway:status'),
    start: () => ipcRenderer.invoke('gateway:start'),
    stop: () => ipcRenderer.invoke('gateway:stop'),
    autoDiscoverKiro: () => ipcRenderer.invoke('gateway:autoDiscoverKiro'),
    scanKiroAccounts: () => ipcRenderer.invoke('gateway:scanKiroAccounts'),
    importScannedAccounts: (ids: string[]) => ipcRenderer.invoke('gateway:importScannedAccounts', ids),
    testKiroAccount: (accountId: string) => ipcRenderer.invoke('gateway:testKiroAccount', accountId),
    toggleKiroAccount: (accountId: string, enabled: boolean) => ipcRenderer.invoke('gateway:toggleKiroAccount', accountId, enabled),
    removeKiroAccount: (accountId: string) => ipcRenderer.invoke('gateway:removeKiroAccount', accountId),
    listModels: () => ipcRenderer.invoke('gateway:listModels'),
    getAccountInfo: (accountId: string) => ipcRenderer.invoke('gateway:getAccountInfo', accountId),
    resetKiroAccount: (accountId: string) => ipcRenderer.invoke('gateway:resetKiroAccount', accountId),
    getKiroSettings: () => ipcRenderer.invoke('gateway:getKiroSettings'),
    updateKiroSettings: (settings: Record<string, any>) => ipcRenderer.invoke('gateway:updateKiroSettings', settings),
    updateKiroRouteName: (routeName: string) => ipcRenderer.invoke('gateway:updateKiroRouteName', routeName),
    addKiroRefreshToken: (text: string) => ipcRenderer.invoke('gateway:addKiroRefreshToken', text),
    addKiroAccessToken: (text: string) => ipcRenderer.invoke('gateway:addKiroAccessToken', text),
    importKiroJson: (text: string) => ipcRenderer.invoke('gateway:importKiroJson', text),
    detectKiroCli: (customPath?: string) => ipcRenderer.invoke('gateway:detectKiroCli', customPath),
    loginWithKiroCli: (options?: { cliPath?: string }) => ipcRenderer.invoke('gateway:loginWithKiroCli', options),
    cancelKiroCliLogin: () => ipcRenderer.invoke('gateway:cancelKiroCliLogin'),
    onCliLoginOutput: (cb: (data: any) => void) => {
      ipcRenderer.on('gateway:cliLoginOutput', (_e, data) => cb(data))
      return () => { ipcRenderer.removeAllListeners('gateway:cliLoginOutput') }
    },
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
