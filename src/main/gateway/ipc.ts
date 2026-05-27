import { ipcMain, BrowserWindow } from 'electron'
import { gatewayHubService } from './service'
import type { AccountStatus, LogCategory, ModelMapping } from './types'
import type { CodexLoginEvent } from './providers/codex/types'
import { DEFAULT_KIRO_SETTINGS } from './providers/kiro/constants'
import { DEFAULT_CODEX_SETTINGS } from './providers/codex/constants'

const KIRO_KEYS = new Set(Object.keys(DEFAULT_KIRO_SETTINGS))
const CODEX_KEYS = new Set(Object.keys(DEFAULT_CODEX_SETTINGS))

function safeHandler(fn: (...args: any[]) => any) {
  return async (...args: any[]) => {
    try {
      return await fn(...args)
    } catch (e) {
      console.error('[ipc] handler error:', e)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
}

export function registerGatewayIpc(): void {
  ipcMain.handle(
    'gateway:status',
    safeHandler(() => gatewayHubService.getStatus())
  )
  ipcMain.handle(
    'gateway:start',
    safeHandler(() => gatewayHubService.start())
  )
  ipcMain.handle(
    'gateway:stop',
    safeHandler(() => gatewayHubService.stop())
  )
  ipcMain.handle(
    'gateway:autoDiscoverKiro',
    safeHandler(() => gatewayHubService.autoDiscoverKiroAccounts())
  )
  ipcMain.handle(
    'gateway:scanKiroAccounts',
    safeHandler(() => gatewayHubService.scanKiroAccounts())
  )
  ipcMain.handle(
    'gateway:importScannedAccounts',
    safeHandler((_event, ids: string[]) => gatewayHubService.importScannedAccounts(ids))
  )
  ipcMain.handle(
    'gateway:testKiroAccount',
    safeHandler((_event, accountId: string) => gatewayHubService.testKiroAccount(accountId))
  )
  ipcMain.handle(
    'gateway:toggleKiroAccount',
    safeHandler((_event, accountId: string, enabled: boolean) =>
      gatewayHubService.toggleKiroAccount(accountId, enabled)
    )
  )
  ipcMain.handle(
    'gateway:removeKiroAccount',
    safeHandler((_event, accountId: string) => gatewayHubService.removeKiroAccount(accountId))
  )
  ipcMain.handle(
    'gateway:listModels',
    safeHandler(() => gatewayHubService.listModels())
  )
  ipcMain.handle(
    'gateway:getAccountInfo',
    safeHandler((_event, accountId: string) => gatewayHubService.getAccountInfo(accountId))
  )
  ipcMain.handle(
    'gateway:resetKiroAccount',
    safeHandler((_event, accountId: string) => gatewayHubService.resetKiroAccount(accountId))
  )
  ipcMain.handle(
    'gateway:setKiroAccountStatus',
    safeHandler((_event, accountId: string, status: string, reason?: string) =>
      gatewayHubService.setKiroAccountStatus(accountId, status as AccountStatus, reason)
    )
  )
  ipcMain.handle(
    'gateway:getKiroSettings',
    safeHandler(() => gatewayHubService.getKiroSettings())
  )
  ipcMain.handle(
    'gateway:updateKiroSettings',
    safeHandler((_event, settings: Record<string, any>) => {
      const filtered = Object.fromEntries(
        Object.entries(settings).filter(([k]) => KIRO_KEYS.has(k))
      )
      return gatewayHubService.updateKiroSettings(filtered)
    })
  )
  ipcMain.handle(
    'gateway:updateKiroRouteName',
    safeHandler((_event, routeName: string) => gatewayHubService.updateKiroRouteName(routeName))
  )
  ipcMain.handle(
    'gateway:updateProviderRouteName',
    safeHandler((_event, providerType: string, routeName: string) =>
      gatewayHubService.updateProviderRouteName(providerType, routeName)
    )
  )
  ipcMain.handle(
    'gateway:addKiroRefreshToken',
    safeHandler((_event, text: string) => gatewayHubService.addKiroRefreshToken(text))
  )
  ipcMain.handle(
    'gateway:addKiroAccessToken',
    safeHandler((_event, text: string) => gatewayHubService.addKiroAccessToken(text))
  )
  ipcMain.handle(
    'gateway:importKiroJson',
    safeHandler((_event, text: string) => gatewayHubService.importKiroJson(text))
  )
  ipcMain.handle(
    'gateway:detectKiroCli',
    safeHandler((_event, customPath?: string) => gatewayHubService.detectKiroCli(customPath))
  )
  ipcMain.handle(
    'gateway:loginWithKiroCli',
    safeHandler((_event, options?: { cliPath?: string }) =>
      gatewayHubService.loginWithKiroCli(options)
    )
  )
  ipcMain.handle(
    'gateway:cancelKiroCliLogin',
    safeHandler(() => gatewayHubService.cancelKiroCliLogin())
  )
  ipcMain.handle(
    'gateway:getModelMappings',
    safeHandler(() => gatewayHubService.getModelMappings())
  )
  ipcMain.handle(
    'gateway:updateModelMappings',
    safeHandler((_event, mappings: ModelMapping[]) =>
      gatewayHubService.updateModelMappings(mappings)
    )
  )
  ipcMain.handle(
    'gateway:generateApiKey',
    safeHandler((_event, options: { name: string; expiresAt?: number; scopes?: string[] }) =>
      gatewayHubService.generateNewApiKey(options)
    )
  )
  ipcMain.handle(
    'gateway:revokeApiKey',
    safeHandler((_event, id: string) => gatewayHubService.revokeApiKey(id))
  )
  ipcMain.handle(
    'gateway:updateApiKey',
    safeHandler(
      (
        _event,
        id: string,
        updates: { name?: string; expiresAt?: number | null; scopes?: string[] | null }
      ) => gatewayHubService.updateApiKey(id, updates)
    )
  )
  ipcMain.handle(
    'gateway:updateProviderDisplayName',
    safeHandler((_event, providerType: string, displayName: string) =>
      gatewayHubService.updateProviderDisplayName(providerType, displayName)
    )
  )
  ipcMain.handle(
    'gateway:getAutoStart',
    safeHandler(() => gatewayHubService.getAutoStart())
  )
  ipcMain.handle(
    'gateway:setAutoStart',
    safeHandler((_event, enabled: boolean) => gatewayHubService.setAutoStart(enabled))
  )
  ipcMain.handle(
    'gateway:clearLogs',
    safeHandler(() => gatewayHubService.clearLogs())
  )
  ipcMain.handle(
    'gateway:getLogs',
    safeHandler(
      (
        _event,
        options?: { category?: LogCategory; requestId?: string; level?: string; limit?: number }
      ) => gatewayHubService.getLogs(options)
    )
  )
  ipcMain.handle(
    'gateway:exportLogs',
    safeHandler((_event, format: 'json' | 'ndjson') => gatewayHubService.exportLogs(format))
  )
  ipcMain.handle(
    'gateway:getPricing',
    safeHandler(() => gatewayHubService.getPricing())
  )
  ipcMain.handle(
    'gateway:readUsage',
    safeHandler(
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
  )
  ipcMain.handle(
    'gateway:clearUsage',
    safeHandler(() => gatewayHubService.clearUsage())
  )

  // ============== Codex ==============

  ipcMain.handle(
    'gateway:scanCodexAccounts',
    safeHandler(() => gatewayHubService.scanCodexAccounts())
  )
  ipcMain.handle(
    'gateway:importScannedCodexAccounts',
    safeHandler((_event, ids: string[]) => gatewayHubService.importScannedCodexAccounts(ids))
  )
  ipcMain.handle(
    'gateway:testCodexAccount',
    safeHandler((_event, accountId: string) => gatewayHubService.testCodexAccount(accountId))
  )
  ipcMain.handle(
    'gateway:toggleCodexAccount',
    safeHandler((_event, accountId: string, enabled: boolean) =>
      gatewayHubService.toggleCodexAccount(accountId, enabled)
    )
  )
  ipcMain.handle(
    'gateway:removeCodexAccount',
    safeHandler((_event, accountId: string) => gatewayHubService.removeCodexAccount(accountId))
  )
  ipcMain.handle(
    'gateway:getCodexAccountInfo',
    safeHandler((_event, accountId: string) => gatewayHubService.getCodexAccountInfo(accountId))
  )
  ipcMain.handle(
    'gateway:resetCodexAccount',
    safeHandler((_event, accountId: string) => gatewayHubService.resetCodexAccount(accountId))
  )
  ipcMain.handle(
    'gateway:setCodexAccountStatus',
    safeHandler((_event, accountId: string, status: string, reason?: string) =>
      gatewayHubService.setCodexAccountStatus(accountId, status as AccountStatus, reason)
    )
  )
  ipcMain.handle(
    'gateway:getCodexSettings',
    safeHandler(() => gatewayHubService.getCodexSettings())
  )
  ipcMain.handle(
    'gateway:updateCodexSettings',
    safeHandler((_event, settings: Record<string, any>) => {
      const filtered = Object.fromEntries(
        Object.entries(settings).filter(([k]) => CODEX_KEYS.has(k))
      )
      return gatewayHubService.updateCodexSettings(filtered)
    })
  )
  ipcMain.handle(
    'gateway:importCodexJson',
    safeHandler((_event, text: string) => gatewayHubService.importCodexAuthJson(text))
  )
  ipcMain.handle(
    'gateway:loginCodexBrowser',
    safeHandler(async (event) => {
      const sender = BrowserWindow.fromWebContents(event.sender)
      const emit = makeCodexLoginEmitter(sender)
      await gatewayHubService.startCodexBrowserLogin(emit)
    })
  )
  ipcMain.handle(
    'gateway:loginCodexDevice',
    safeHandler(async (event) => {
      const sender = BrowserWindow.fromWebContents(event.sender)
      const emit = makeCodexLoginEmitter(sender)
      await gatewayHubService.startCodexDeviceLogin(emit)
    })
  )
  ipcMain.handle(
    'gateway:cancelCodexLogin',
    safeHandler(() => gatewayHubService.cancelCodexLogin())
  )
}

function makeCodexLoginEmitter(window: BrowserWindow | null): (event: CodexLoginEvent) => void {
  return (event) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send('gateway:codexLoginEvent', event)
    }
  }
}
