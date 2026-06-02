import { ipcMain, BrowserWindow } from 'electron'
import { gatewayHubService } from './service'
import type { AccountStatus, LogCategory, ModelMapping } from './types'
import type { CodexLoginEvent } from './providers/codex/types'
import { DEFAULT_KIRO_SETTINGS } from './providers/kiro/constants'
import { DEFAULT_CODEX_SETTINGS } from './providers/codex/constants'
import { DEFAULT_TRAE_SETTINGS } from './providers/trae/constants'
import { DEFAULT_OPENROUTER_SETTINGS } from './providers/openrouter/constants'
import { DEFAULT_NVIDIA_SETTINGS } from './providers/nvidia/constants'
import { DEFAULT_GPT_WEB_SETTINGS } from './providers/gptWeb/constants'
import { DEFAULT_GROK_WEB_SETTINGS } from './providers/grokWeb/constants'

const KIRO_KEYS = new Set(Object.keys(DEFAULT_KIRO_SETTINGS))
const CODEX_KEYS = new Set(Object.keys(DEFAULT_CODEX_SETTINGS))
const TRAE_KEYS = new Set(Object.keys(DEFAULT_TRAE_SETTINGS))
const OPENROUTER_KEYS = new Set(Object.keys(DEFAULT_OPENROUTER_SETTINGS))
const NVIDIA_KEYS = new Set(Object.keys(DEFAULT_NVIDIA_SETTINGS))
const GPT_WEB_KEYS = new Set(Object.keys(DEFAULT_GPT_WEB_SETTINGS))
const GROK_WEB_KEYS = new Set(Object.keys(DEFAULT_GROK_WEB_SETTINGS))

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
    'gateway:refreshKiroAccountModels',
    safeHandler((_event, accountId: string) =>
      gatewayHubService.refreshKiroAccountModels(accountId)
    )
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
    'gateway:setPort',
    safeHandler((_event, port: number) => gatewayHubService.setPort(port))
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

  // ============== Windsurf ==============

  ipcMain.handle(
    'gateway:scanWindsurfAccounts',
    safeHandler(() => gatewayHubService.scanWindsurfAccounts())
  )
  ipcMain.handle(
    'gateway:importScannedWindsurfAccounts',
    safeHandler((_event, ids: string[]) => gatewayHubService.importScannedWindsurfAccounts(ids))
  )
  ipcMain.handle(
    'gateway:importWindsurfJson',
    safeHandler((_event, text: string) => gatewayHubService.importWindsurfAuthJson(text))
  )
  ipcMain.handle(
    'gateway:addWindsurfApiKey',
    safeHandler((_event, text: string) => gatewayHubService.addWindsurfApiKey(text))
  )
  ipcMain.handle(
    'gateway:testWindsurfAccount',
    safeHandler((_event, accountId: string) => gatewayHubService.testWindsurfAccount(accountId))
  )
  ipcMain.handle(
    'gateway:toggleWindsurfAccount',
    safeHandler((_event, accountId: string, enabled: boolean) =>
      gatewayHubService.toggleWindsurfAccount(accountId, enabled)
    )
  )
  ipcMain.handle(
    'gateway:removeWindsurfAccount',
    safeHandler((_event, accountId: string) => gatewayHubService.removeWindsurfAccount(accountId))
  )
  ipcMain.handle(
    'gateway:getWindsurfAccountInfo',
    safeHandler((_event, accountId: string) => gatewayHubService.getWindsurfAccountInfo(accountId))
  )
  ipcMain.handle(
    'gateway:refreshWindsurfAccountModels',
    safeHandler((_event, accountId: string) =>
      gatewayHubService.refreshWindsurfAccountModels(accountId)
    )
  )
  ipcMain.handle(
    'gateway:resetWindsurfAccount',
    safeHandler((_event, accountId: string) => gatewayHubService.resetWindsurfAccount(accountId))
  )
  ipcMain.handle(
    'gateway:setWindsurfAccountStatus',
    safeHandler((_event, accountId: string, status: string, reason?: string) =>
      gatewayHubService.setWindsurfAccountStatus(accountId, status as AccountStatus, reason)
    )
  )

  // ============== Trae ==============

  ipcMain.handle(
    'gateway:scanTraeAccounts',
    safeHandler(() => gatewayHubService.scanTraeAccounts())
  )
  ipcMain.handle(
    'gateway:importScannedTraeAccounts',
    safeHandler((_event, ids: string[]) => gatewayHubService.importScannedTraeAccounts(ids))
  )
  ipcMain.handle(
    'gateway:importTraeJson',
    safeHandler((_event, text: string) => gatewayHubService.importTraeAuthJson(text))
  )
  ipcMain.handle(
    'gateway:addTraeJwtToken',
    safeHandler((_event, text: string) => gatewayHubService.addTraeJwtToken(text))
  )
  ipcMain.handle(
    'gateway:addTraeRefreshToken',
    safeHandler((_event, text: string) => gatewayHubService.addTraeRefreshToken(text))
  )
  ipcMain.handle(
    'gateway:testTraeAccount',
    safeHandler((_event, accountId: string) => gatewayHubService.testTraeAccount(accountId))
  )
  ipcMain.handle(
    'gateway:toggleTraeAccount',
    safeHandler((_event, accountId: string, enabled: boolean) =>
      gatewayHubService.toggleTraeAccount(accountId, enabled)
    )
  )
  ipcMain.handle(
    'gateway:removeTraeAccount',
    safeHandler((_event, accountId: string) => gatewayHubService.removeTraeAccount(accountId))
  )
  ipcMain.handle(
    'gateway:getTraeAccountInfo',
    safeHandler((_event, accountId: string) => gatewayHubService.getTraeAccountInfo(accountId))
  )
  ipcMain.handle(
    'gateway:refreshTraeAccountModels',
    safeHandler((_event, accountId: string) =>
      gatewayHubService.refreshTraeAccountModels(accountId)
    )
  )
  ipcMain.handle(
    'gateway:resetTraeAccount',
    safeHandler((_event, accountId: string) => gatewayHubService.resetTraeAccount(accountId))
  )
  ipcMain.handle(
    'gateway:setTraeAccountStatus',
    safeHandler((_event, accountId: string, status: string, reason?: string) =>
      gatewayHubService.setTraeAccountStatus(accountId, status as AccountStatus, reason)
    )
  )
  ipcMain.handle(
    'gateway:getTraeSettings',
    safeHandler(() => gatewayHubService.getTraeSettings())
  )
  ipcMain.handle(
    'gateway:updateTraeSettings',
    safeHandler((_event, settings: Record<string, any>) => {
      const filtered = Object.fromEntries(
        Object.entries(settings).filter(([k]) => TRAE_KEYS.has(k))
      )
      return gatewayHubService.updateTraeSettings(filtered)
    })
  )

  // ============== OpenRouter ==============

  ipcMain.handle(
    'gateway:addOpenRouterApiKey',
    safeHandler((_event, text: string) => gatewayHubService.addOpenRouterApiKey(text))
  )
  ipcMain.handle(
    'gateway:importOpenRouterJson',
    safeHandler((_event, text: string) => gatewayHubService.importOpenRouterAuthJson(text))
  )
  ipcMain.handle(
    'gateway:testOpenRouterAccount',
    safeHandler((_event, accountId: string) => gatewayHubService.testOpenRouterAccount(accountId))
  )
  ipcMain.handle(
    'gateway:toggleOpenRouterAccount',
    safeHandler((_event, accountId: string, enabled: boolean) =>
      gatewayHubService.toggleOpenRouterAccount(accountId, enabled)
    )
  )
  ipcMain.handle(
    'gateway:removeOpenRouterAccount',
    safeHandler((_event, accountId: string) => gatewayHubService.removeOpenRouterAccount(accountId))
  )
  ipcMain.handle(
    'gateway:getOpenRouterAccountInfo',
    safeHandler((_event, accountId: string) =>
      gatewayHubService.getOpenRouterAccountInfo(accountId)
    )
  )
  ipcMain.handle(
    'gateway:refreshOpenRouterAccountModels',
    safeHandler((_event, accountId: string) =>
      gatewayHubService.refreshOpenRouterAccountModels(accountId)
    )
  )
  ipcMain.handle(
    'gateway:resetOpenRouterAccount',
    safeHandler((_event, accountId: string) => gatewayHubService.resetOpenRouterAccount(accountId))
  )
  ipcMain.handle(
    'gateway:setOpenRouterAccountStatus',
    safeHandler((_event, accountId: string, status: string, reason?: string) =>
      gatewayHubService.setOpenRouterAccountStatus(accountId, status as AccountStatus, reason)
    )
  )
  ipcMain.handle(
    'gateway:getOpenRouterSettings',
    safeHandler(() => gatewayHubService.getOpenRouterSettings())
  )
  ipcMain.handle(
    'gateway:updateOpenRouterSettings',
    safeHandler((_event, settings: Record<string, any>) => {
      const filtered = Object.fromEntries(
        Object.entries(settings).filter(([k]) => OPENROUTER_KEYS.has(k))
      )
      return gatewayHubService.updateOpenRouterSettings(filtered)
    })
  )

  // ============== NVIDIA ==============

  ipcMain.handle(
    'gateway:addNvidiaApiKey',
    safeHandler((_event, text: string) => gatewayHubService.addNvidiaApiKey(text))
  )
  ipcMain.handle(
    'gateway:importNvidiaJson',
    safeHandler((_event, text: string) => gatewayHubService.importNvidiaAuthJson(text))
  )
  ipcMain.handle(
    'gateway:testNvidiaAccount',
    safeHandler((_event, accountId: string) => gatewayHubService.testNvidiaAccount(accountId))
  )
  ipcMain.handle(
    'gateway:toggleNvidiaAccount',
    safeHandler((_event, accountId: string, enabled: boolean) =>
      gatewayHubService.toggleNvidiaAccount(accountId, enabled)
    )
  )
  ipcMain.handle(
    'gateway:removeNvidiaAccount',
    safeHandler((_event, accountId: string) => gatewayHubService.removeNvidiaAccount(accountId))
  )
  ipcMain.handle(
    'gateway:getNvidiaAccountInfo',
    safeHandler((_event, accountId: string) => gatewayHubService.getNvidiaAccountInfo(accountId))
  )
  ipcMain.handle(
    'gateway:refreshNvidiaAccountModels',
    safeHandler((_event, accountId: string) =>
      gatewayHubService.refreshNvidiaAccountModels(accountId)
    )
  )
  ipcMain.handle(
    'gateway:resetNvidiaAccount',
    safeHandler((_event, accountId: string) => gatewayHubService.resetNvidiaAccount(accountId))
  )
  ipcMain.handle(
    'gateway:setNvidiaAccountStatus',
    safeHandler((_event, accountId: string, status: string, reason?: string) =>
      gatewayHubService.setNvidiaAccountStatus(accountId, status as AccountStatus, reason)
    )
  )
  ipcMain.handle(
    'gateway:getNvidiaSettings',
    safeHandler(() => gatewayHubService.getNvidiaSettings())
  )
  ipcMain.handle(
    'gateway:updateNvidiaSettings',
    safeHandler((_event, settings: Record<string, any>) => {
      const filtered = Object.fromEntries(
        Object.entries(settings).filter(([k]) => NVIDIA_KEYS.has(k))
      )
      return gatewayHubService.updateNvidiaSettings(filtered)
    })
  )

  // ============== GptWeb ==============

  ipcMain.handle(
    'gateway:importGptWebJson',
    safeHandler((_event, text: string) => gatewayHubService.importGptWebAuthJson(text))
  )
  ipcMain.handle(
    'gateway:testGptWebAccount',
    safeHandler((_event, accountId: string) => gatewayHubService.testGptWebAccount(accountId))
  )
  ipcMain.handle(
    'gateway:toggleGptWebAccount',
    safeHandler((_event, accountId: string, enabled: boolean) =>
      gatewayHubService.toggleGptWebAccount(accountId, enabled)
    )
  )
  ipcMain.handle(
    'gateway:removeGptWebAccount',
    safeHandler((_event, accountId: string) => gatewayHubService.removeGptWebAccount(accountId))
  )
  ipcMain.handle(
    'gateway:getGptWebAccountInfo',
    safeHandler((_event, accountId: string) => gatewayHubService.getGptWebAccountInfo(accountId))
  )
  ipcMain.handle(
    'gateway:refreshGptWebAccountModels',
    safeHandler((_event, accountId: string) =>
      gatewayHubService.refreshGptWebAccountModels(accountId)
    )
  )
  ipcMain.handle(
    'gateway:resetGptWebAccount',
    safeHandler((_event, accountId: string) => gatewayHubService.resetGptWebAccount(accountId))
  )
  ipcMain.handle(
    'gateway:setGptWebAccountStatus',
    safeHandler((_event, accountId: string, status: string, reason?: string) =>
      gatewayHubService.setGptWebAccountStatus(accountId, status as AccountStatus, reason)
    )
  )
  ipcMain.handle(
    'gateway:getGptWebSettings',
    safeHandler(() => gatewayHubService.getGptWebSettings())
  )
  ipcMain.handle(
    'gateway:updateGptWebSettings',
    safeHandler((_event, settings: Record<string, any>) => {
      const filtered = Object.fromEntries(
        Object.entries(settings).filter(([k]) => GPT_WEB_KEYS.has(k))
      )
      return gatewayHubService.updateGptWebSettings(filtered)
    })
  )

  // ============== Grok Web ==============

  ipcMain.handle(
    'gateway:importGrokWebJson',
    safeHandler((_event, text: string) => gatewayHubService.importGrokWebAuthJson(text))
  )
  ipcMain.handle(
    'gateway:testGrokWebAccount',
    safeHandler((_event, accountId: string) => gatewayHubService.testGrokWebAccount(accountId))
  )
  ipcMain.handle(
    'gateway:toggleGrokWebAccount',
    safeHandler((_event, accountId: string, enabled: boolean) =>
      gatewayHubService.toggleGrokWebAccount(accountId, enabled)
    )
  )
  ipcMain.handle(
    'gateway:removeGrokWebAccount',
    safeHandler((_event, accountId: string) => gatewayHubService.removeGrokWebAccount(accountId))
  )
  ipcMain.handle(
    'gateway:getGrokWebAccountInfo',
    safeHandler((_event, accountId: string) => gatewayHubService.getGrokWebAccountInfo(accountId))
  )
  ipcMain.handle(
    'gateway:refreshGrokWebAccountModels',
    safeHandler((_event, accountId: string) =>
      gatewayHubService.refreshGrokWebAccountModels(accountId)
    )
  )
  ipcMain.handle(
    'gateway:resetGrokWebAccount',
    safeHandler((_event, accountId: string) => gatewayHubService.resetGrokWebAccount(accountId))
  )
  ipcMain.handle(
    'gateway:setGrokWebAccountStatus',
    safeHandler((_event, accountId: string, status: string, reason?: string) =>
      gatewayHubService.setGrokWebAccountStatus(accountId, status as AccountStatus, reason)
    )
  )
  ipcMain.handle(
    'gateway:getGrokWebSettings',
    safeHandler(() => gatewayHubService.getGrokWebSettings())
  )
  ipcMain.handle(
    'gateway:updateGrokWebSettings',
    safeHandler((_event, settings: Record<string, any>) => {
      const filtered = Object.fromEntries(
        Object.entries(settings).filter(([k]) => GROK_WEB_KEYS.has(k))
      )
      return gatewayHubService.updateGrokWebSettings(filtered)
    })
  )
}

function makeCodexLoginEmitter(window: BrowserWindow | null): (event: CodexLoginEvent) => void {
  return (event) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send('gateway:codexLoginEvent', event)
    }
  }
}
