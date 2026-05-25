import { ipcMain, BrowserWindow } from 'electron'
import { gatewayHubService } from './service'
import type { AccountStatus, LogCategory, ModelMapping } from './types'
import type { CodexLoginEvent } from './providers/codex/types'

export function registerGatewayIpc(): void {
  ipcMain.handle('gateway:status', () => gatewayHubService.getStatus())
  ipcMain.handle('gateway:start', () => gatewayHubService.start())
  ipcMain.handle('gateway:stop', () => gatewayHubService.stop())
  ipcMain.handle('gateway:autoDiscoverKiro', () => gatewayHubService.autoDiscoverKiroAccounts())
  ipcMain.handle('gateway:scanKiroAccounts', () => gatewayHubService.scanKiroAccounts())
  ipcMain.handle('gateway:importScannedAccounts', (_event, ids: string[]) =>
    gatewayHubService.importScannedAccounts(ids)
  )
  ipcMain.handle('gateway:testKiroAccount', (_event, accountId: string) =>
    gatewayHubService.testKiroAccount(accountId)
  )
  ipcMain.handle('gateway:toggleKiroAccount', (_event, accountId: string, enabled: boolean) =>
    gatewayHubService.toggleKiroAccount(accountId, enabled)
  )
  ipcMain.handle('gateway:removeKiroAccount', (_event, accountId: string) =>
    gatewayHubService.removeKiroAccount(accountId)
  )
  ipcMain.handle('gateway:listModels', () => gatewayHubService.listModels())
  ipcMain.handle('gateway:getAccountInfo', (_event, accountId: string) =>
    gatewayHubService.getAccountInfo(accountId)
  )
  ipcMain.handle('gateway:resetKiroAccount', (_event, accountId: string) =>
    gatewayHubService.resetKiroAccount(accountId)
  )
  ipcMain.handle(
    'gateway:setKiroAccountStatus',
    (_event, accountId: string, status: string, reason?: string) =>
      gatewayHubService.setKiroAccountStatus(accountId, status as AccountStatus, reason)
  )
  ipcMain.handle('gateway:getKiroSettings', () => gatewayHubService.getKiroSettings())
  ipcMain.handle('gateway:updateKiroSettings', (_event, settings: Record<string, any>) =>
    gatewayHubService.updateKiroSettings(settings)
  )
  ipcMain.handle('gateway:updateKiroRouteName', (_event, routeName: string) =>
    gatewayHubService.updateKiroRouteName(routeName)
  )
  ipcMain.handle(
    'gateway:updateProviderRouteName',
    (_event, providerType: string, routeName: string) =>
      gatewayHubService.updateProviderRouteName(providerType, routeName)
  )
  ipcMain.handle('gateway:addKiroRefreshToken', (_event, text: string) =>
    gatewayHubService.addKiroRefreshToken(text)
  )
  ipcMain.handle('gateway:addKiroAccessToken', (_event, text: string) =>
    gatewayHubService.addKiroAccessToken(text)
  )
  ipcMain.handle('gateway:importKiroJson', (_event, text: string) =>
    gatewayHubService.importKiroJson(text)
  )
  ipcMain.handle('gateway:detectKiroCli', (_event, customPath?: string) =>
    gatewayHubService.detectKiroCli(customPath)
  )
  ipcMain.handle('gateway:loginWithKiroCli', (_event, options?: { cliPath?: string }) =>
    gatewayHubService.loginWithKiroCli(options)
  )
  ipcMain.handle('gateway:cancelKiroCliLogin', () => gatewayHubService.cancelKiroCliLogin())
  ipcMain.handle('gateway:getModelMappings', () => gatewayHubService.getModelMappings())
  ipcMain.handle('gateway:updateModelMappings', (_event, mappings: ModelMapping[]) =>
    gatewayHubService.updateModelMappings(mappings)
  )
  ipcMain.handle(
    'gateway:generateApiKey',
    (_event, options: { name: string; expiresAt?: number; scopes?: string[] }) =>
      gatewayHubService.generateNewApiKey(options)
  )
  ipcMain.handle('gateway:revokeApiKey', (_event, id: string) => gatewayHubService.revokeApiKey(id))
  ipcMain.handle(
    'gateway:updateApiKey',
    (
      _event,
      id: string,
      updates: { name?: string; expiresAt?: number | null; scopes?: string[] | null }
    ) => gatewayHubService.updateApiKey(id, updates)
  )
  ipcMain.handle(
    'gateway:updateProviderDisplayName',
    (_event, providerType: string, displayName: string) =>
      gatewayHubService.updateProviderDisplayName(providerType, displayName)
  )
  ipcMain.handle('gateway:getAutoStart', () => gatewayHubService.getAutoStart())
  ipcMain.handle('gateway:setAutoStart', (_event, enabled: boolean) =>
    gatewayHubService.setAutoStart(enabled)
  )
  ipcMain.handle('gateway:clearLogs', () => gatewayHubService.clearLogs())
  ipcMain.handle(
    'gateway:getLogs',
    (
      _event,
      options?: { category?: LogCategory; requestId?: string; level?: string; limit?: number }
    ) => gatewayHubService.getLogs(options)
  )
  ipcMain.handle('gateway:exportLogs', (_event, format: 'json' | 'ndjson') =>
    gatewayHubService.exportLogs(format)
  )
  ipcMain.handle('gateway:getPricing', () => gatewayHubService.getPricing())
  ipcMain.handle(
    'gateway:readUsage',
    (
      _event,
      options?: {
        sinceKey?: string
        untilKey?: string
        accountId?: string
        model?: string
        provider?: string
      }
    ) => gatewayHubService.readUsage(options)
  )
  ipcMain.handle('gateway:clearUsage', () => gatewayHubService.clearUsage())

  // ============== Codex ==============

  ipcMain.handle('gateway:scanCodexAccounts', () => gatewayHubService.scanCodexAccounts())
  ipcMain.handle('gateway:importScannedCodexAccounts', (_event, ids: string[]) =>
    gatewayHubService.importScannedCodexAccounts(ids)
  )
  ipcMain.handle('gateway:testCodexAccount', (_event, accountId: string) =>
    gatewayHubService.testCodexAccount(accountId)
  )
  ipcMain.handle('gateway:toggleCodexAccount', (_event, accountId: string, enabled: boolean) =>
    gatewayHubService.toggleCodexAccount(accountId, enabled)
  )
  ipcMain.handle('gateway:removeCodexAccount', (_event, accountId: string) =>
    gatewayHubService.removeCodexAccount(accountId)
  )
  ipcMain.handle('gateway:getCodexAccountInfo', (_event, accountId: string) =>
    gatewayHubService.getCodexAccountInfo(accountId)
  )
  ipcMain.handle('gateway:resetCodexAccount', (_event, accountId: string) =>
    gatewayHubService.resetCodexAccount(accountId)
  )
  ipcMain.handle(
    'gateway:setCodexAccountStatus',
    (_event, accountId: string, status: string, reason?: string) =>
      gatewayHubService.setCodexAccountStatus(accountId, status as AccountStatus, reason)
  )
  ipcMain.handle('gateway:getCodexSettings', () => gatewayHubService.getCodexSettings())
  ipcMain.handle('gateway:updateCodexSettings', (_event, settings: Record<string, any>) =>
    gatewayHubService.updateCodexSettings(settings)
  )
  ipcMain.handle('gateway:importCodexJson', (_event, text: string) =>
    gatewayHubService.importCodexAuthJson(text)
  )
  ipcMain.handle('gateway:loginCodexBrowser', async (event) => {
    const sender = BrowserWindow.fromWebContents(event.sender)
    const emit = makeCodexLoginEmitter(sender)
    await gatewayHubService.startCodexBrowserLogin(emit)
  })
  ipcMain.handle('gateway:loginCodexDevice', async (event) => {
    const sender = BrowserWindow.fromWebContents(event.sender)
    const emit = makeCodexLoginEmitter(sender)
    await gatewayHubService.startCodexDeviceLogin(emit)
  })
  ipcMain.handle('gateway:cancelCodexLogin', () => gatewayHubService.cancelCodexLogin())
}

function makeCodexLoginEmitter(window: BrowserWindow | null): (event: CodexLoginEvent) => void {
  return (event) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send('gateway:codexLoginEvent', event)
    }
  }
}
