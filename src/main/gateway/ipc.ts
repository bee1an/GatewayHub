import { ipcMain, BrowserWindow } from 'electron'
import { gatewayHubService } from './service'
import type { AccountStatus, LogCategory, ModelMapping } from './types'
import type { GatewayStatusSnapshot } from './types'
import { daemonStatus, daemonStop, notifyDaemonReload } from '../../cli/daemon/controller'
import type { CodexLoginEvent } from './providers/codex/types'
import { DEFAULT_KIRO_SETTINGS } from './providers/kiro/constants'
import { DEFAULT_CODEX_SETTINGS } from './providers/codex/constants'
import { DEFAULT_WINDSURF_SETTINGS } from './providers/windsurf/constants'
import { DEFAULT_TRAE_SETTINGS } from './providers/trae/constants'
import { DEFAULT_OPENROUTER_SETTINGS } from './providers/openrouter/constants'
import { DEFAULT_NVIDIA_SETTINGS } from './providers/nvidia/constants'
import { DEFAULT_GPT_WEB_SETTINGS } from './providers/gptWeb/constants'
import { DEFAULT_GROK_WEB_SETTINGS } from './providers/grokWeb/constants'
import { DEFAULT_GEMINI_WEB_SETTINGS } from './providers/geminiWeb/constants'
import { DEFAULT_QODER_SETTINGS } from './providers/qoder/constants'

const KIRO_KEYS = new Set(Object.keys(DEFAULT_KIRO_SETTINGS))
const CODEX_KEYS = new Set(Object.keys(DEFAULT_CODEX_SETTINGS))
const WINDSURF_KEYS = new Set(Object.keys(DEFAULT_WINDSURF_SETTINGS))
const TRAE_KEYS = new Set(Object.keys(DEFAULT_TRAE_SETTINGS))
const OPENROUTER_KEYS = new Set(Object.keys(DEFAULT_OPENROUTER_SETTINGS))
const NVIDIA_KEYS = new Set(Object.keys(DEFAULT_NVIDIA_SETTINGS))
const GPT_WEB_KEYS = new Set(Object.keys(DEFAULT_GPT_WEB_SETTINGS))
const GROK_WEB_KEYS = new Set(Object.keys(DEFAULT_GROK_WEB_SETTINGS))
const GEMINI_WEB_KEYS = new Set(Object.keys(DEFAULT_GEMINI_WEB_SETTINGS))
const QODER_KEYS = new Set(Object.keys(DEFAULT_QODER_SETTINGS))

function safeHandler(fn: (...args: any[]) => any) {
  return async (...args: any[]) => {
    try {
      return await fn(...args)
    } catch (e) {
      console.error('[ipc] handler error:', e)
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        code: typeof (e as any)?.code === 'string' ? (e as any).code : undefined
      }
    }
  }
}

export function registerGatewayIpc(): void {
  ipcMain.handle(
    'gateway:status',
    safeHandler(() => getGatewayStatusForUi())
  )
  ipcMain.handle(
    'gateway:start',
    safeHandler(() => startGatewayForUi())
  )
  ipcMain.handle(
    'gateway:stop',
    safeHandler(() => stopGatewayForUi())
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
    safeHandler((_event, ids: string[]) =>
      withDaemonReload(() => gatewayHubService.importScannedAccounts(ids))
    )
  )
  ipcMain.handle(
    'gateway:testKiroAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.testKiroAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:toggleKiroAccount',
    safeHandler((_event, accountId: string, enabled: boolean) =>
      withDaemonReload(() => gatewayHubService.toggleKiroAccount(accountId, enabled))
    )
  )
  ipcMain.handle(
    'gateway:removeKiroAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.removeKiroAccount(accountId))
    )
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
      withDaemonReload(() => gatewayHubService.refreshKiroAccountModels(accountId))
    )
  )
  ipcMain.handle(
    'gateway:resetKiroAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.resetKiroAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:setKiroAccountStatus',
    safeHandler((_event, accountId: string, status: string, reason?: string) =>
      withDaemonReload(() =>
        gatewayHubService.setKiroAccountStatus(accountId, status as AccountStatus, reason)
      )
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
      return withDaemonReload(() => gatewayHubService.updateKiroSettings(filtered))
    })
  )
  ipcMain.handle(
    'gateway:updateKiroRouteName',
    safeHandler((_event, routeName: string) =>
      withDaemonReload(() => gatewayHubService.updateKiroRouteName(routeName))
    )
  )
  ipcMain.handle(
    'gateway:updateProviderRouteName',
    safeHandler((_event, providerType: string, routeName: string) =>
      withDaemonReload(() => gatewayHubService.updateProviderRouteName(providerType, routeName))
    )
  )
  ipcMain.handle(
    'gateway:addKiroRefreshToken',
    safeHandler((_event, text: string) =>
      withDaemonReload(() => gatewayHubService.addKiroRefreshToken(text))
    )
  )
  ipcMain.handle(
    'gateway:addKiroAccessToken',
    safeHandler((_event, text: string) =>
      withDaemonReload(() => gatewayHubService.addKiroAccessToken(text))
    )
  )
  ipcMain.handle(
    'gateway:importKiroJson',
    safeHandler((_event, text: string) =>
      withDaemonReload(() => gatewayHubService.importKiroJson(text))
    )
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
      withDaemonReload(() => gatewayHubService.updateModelMappings(mappings))
    )
  )
  ipcMain.handle(
    'gateway:generateApiKey',
    safeHandler((_event, options: { name: string; expiresAt?: number; scopes?: string[] }) =>
      withDaemonReload(() => gatewayHubService.generateNewApiKey(options))
    )
  )
  ipcMain.handle(
    'gateway:revokeApiKey',
    safeHandler((_event, id: string) => withDaemonReload(() => gatewayHubService.revokeApiKey(id)))
  )
  ipcMain.handle(
    'gateway:updateApiKey',
    safeHandler(
      (
        _event,
        id: string,
        updates: { name?: string; expiresAt?: number | null; scopes?: string[] | null }
      ) => withDaemonReload(() => gatewayHubService.updateApiKey(id, updates))
    )
  )
  ipcMain.handle(
    'gateway:updateProviderDisplayName',
    safeHandler((_event, providerType: string, displayName: string) =>
      withDaemonReload(() => gatewayHubService.updateProviderDisplayName(providerType, displayName))
    )
  )
  ipcMain.handle(
    'gateway:setPort',
    safeHandler((_event, port: number) => withDaemonReload(() => gatewayHubService.setPort(port)))
  )
  ipcMain.handle(
    'gateway:setHost',
    safeHandler((_event, host: string) => withDaemonReload(() => gatewayHubService.setHost(host)))
  )
  ipcMain.handle(
    'gateway:getHost',
    safeHandler(() => gatewayHubService.getHost())
  )
  ipcMain.handle(
    'gateway:getProxyUrl',
    safeHandler(() => gatewayHubService.getProxyUrl())
  )
  ipcMain.handle(
    'gateway:setProxyUrl',
    safeHandler((_event, url: string) => withDaemonReload(() => gatewayHubService.setProxyUrl(url)))
  )
  ipcMain.handle(
    'gateway:setProviderUseProxy',
    safeHandler((_event, providerType: string, enabled: boolean) =>
      withDaemonReload(() => gatewayHubService.setProviderUseProxy(providerType, enabled))
    )
  )
  ipcMain.handle(
    'gateway:getAutoStart',
    safeHandler(() => gatewayHubService.getAutoStart())
  )
  ipcMain.handle(
    'gateway:setAutoStart',
    safeHandler((_event, enabled: boolean) =>
      withDaemonReload(() => gatewayHubService.setAutoStart(enabled))
    )
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
    safeHandler((_event, ids: string[]) =>
      withDaemonReload(() => gatewayHubService.importScannedCodexAccounts(ids))
    )
  )
  ipcMain.handle(
    'gateway:testCodexAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.testCodexAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:toggleCodexAccount',
    safeHandler((_event, accountId: string, enabled: boolean) =>
      withDaemonReload(() => gatewayHubService.toggleCodexAccount(accountId, enabled))
    )
  )
  ipcMain.handle(
    'gateway:removeCodexAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.removeCodexAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:getCodexAccountInfo',
    safeHandler((_event, accountId: string) => gatewayHubService.getCodexAccountInfo(accountId))
  )
  ipcMain.handle(
    'gateway:resetCodexAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.resetCodexAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:setCodexAccountStatus',
    safeHandler((_event, accountId: string, status: string, reason?: string) =>
      withDaemonReload(() =>
        gatewayHubService.setCodexAccountStatus(accountId, status as AccountStatus, reason)
      )
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
    safeHandler((_event, text: string) =>
      withDaemonReload(() => gatewayHubService.importCodexAuthJson(text))
    )
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
    safeHandler((_event, ids: string[]) =>
      withDaemonReload(() => gatewayHubService.importScannedWindsurfAccounts(ids))
    )
  )
  ipcMain.handle(
    'gateway:importWindsurfJson',
    safeHandler((_event, text: string) =>
      withDaemonReload(() => gatewayHubService.importWindsurfAuthJson(text))
    )
  )
  ipcMain.handle(
    'gateway:addWindsurfApiKey',
    safeHandler((_event, text: string) =>
      withDaemonReload(() => gatewayHubService.addWindsurfApiKey(text))
    )
  )
  ipcMain.handle(
    'gateway:testWindsurfAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.testWindsurfAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:toggleWindsurfAccount',
    safeHandler((_event, accountId: string, enabled: boolean) =>
      withDaemonReload(() => gatewayHubService.toggleWindsurfAccount(accountId, enabled))
    )
  )
  ipcMain.handle(
    'gateway:removeWindsurfAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.removeWindsurfAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:getWindsurfAccountInfo',
    safeHandler((_event, accountId: string) => gatewayHubService.getWindsurfAccountInfo(accountId))
  )
  ipcMain.handle(
    'gateway:refreshWindsurfAccountModels',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.refreshWindsurfAccountModels(accountId))
    )
  )
  ipcMain.handle(
    'gateway:resetWindsurfAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.resetWindsurfAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:setWindsurfAccountStatus',
    safeHandler((_event, accountId: string, status: string, reason?: string) =>
      withDaemonReload(() =>
        gatewayHubService.setWindsurfAccountStatus(accountId, status as AccountStatus, reason)
      )
    )
  )
  ipcMain.handle(
    'gateway:getWindsurfSettings',
    safeHandler(() => gatewayHubService.getWindsurfSettings())
  )
  ipcMain.handle(
    'gateway:updateWindsurfSettings',
    safeHandler((_event, settings: Record<string, any>) => {
      const filtered = Object.fromEntries(
        Object.entries(settings).filter(([k]) => WINDSURF_KEYS.has(k))
      )
      return gatewayHubService.updateWindsurfSettings(filtered)
    })
  )

  // ============== Trae ==============

  ipcMain.handle(
    'gateway:scanTraeAccounts',
    safeHandler(() => gatewayHubService.scanTraeAccounts())
  )
  ipcMain.handle(
    'gateway:importScannedTraeAccounts',
    safeHandler((_event, ids: string[]) =>
      withDaemonReload(() => gatewayHubService.importScannedTraeAccounts(ids))
    )
  )
  ipcMain.handle(
    'gateway:importTraeJson',
    safeHandler((_event, text: string) =>
      withDaemonReload(() => gatewayHubService.importTraeAuthJson(text))
    )
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
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.testTraeAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:toggleTraeAccount',
    safeHandler((_event, accountId: string, enabled: boolean) =>
      withDaemonReload(() => gatewayHubService.toggleTraeAccount(accountId, enabled))
    )
  )
  ipcMain.handle(
    'gateway:removeTraeAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.removeTraeAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:getTraeAccountInfo',
    safeHandler((_event, accountId: string) => gatewayHubService.getTraeAccountInfo(accountId))
  )
  ipcMain.handle(
    'gateway:refreshTraeAccountModels',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.refreshTraeAccountModels(accountId))
    )
  )
  ipcMain.handle(
    'gateway:resetTraeAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.resetTraeAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:setTraeAccountStatus',
    safeHandler((_event, accountId: string, status: string, reason?: string) =>
      withDaemonReload(() =>
        gatewayHubService.setTraeAccountStatus(accountId, status as AccountStatus, reason)
      )
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
    safeHandler((_event, text: string) =>
      withDaemonReload(() => gatewayHubService.addOpenRouterApiKey(text))
    )
  )
  ipcMain.handle(
    'gateway:importOpenRouterJson',
    safeHandler((_event, text: string) => gatewayHubService.importOpenRouterAuthJson(text))
  )
  ipcMain.handle(
    'gateway:testOpenRouterAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.testOpenRouterAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:toggleOpenRouterAccount',
    safeHandler((_event, accountId: string, enabled: boolean) =>
      withDaemonReload(() => gatewayHubService.toggleOpenRouterAccount(accountId, enabled))
    )
  )
  ipcMain.handle(
    'gateway:removeOpenRouterAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.removeOpenRouterAccount(accountId))
    )
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
      withDaemonReload(() => gatewayHubService.refreshOpenRouterAccountModels(accountId))
    )
  )
  ipcMain.handle(
    'gateway:resetOpenRouterAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.resetOpenRouterAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:setOpenRouterAccountStatus',
    safeHandler((_event, accountId: string, status: string, reason?: string) =>
      withDaemonReload(() =>
        gatewayHubService.setOpenRouterAccountStatus(accountId, status as AccountStatus, reason)
      )
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
    safeHandler((_event, text: string) =>
      withDaemonReload(() => gatewayHubService.addNvidiaApiKey(text))
    )
  )
  ipcMain.handle(
    'gateway:importNvidiaJson',
    safeHandler((_event, text: string) => gatewayHubService.importNvidiaAuthJson(text))
  )
  ipcMain.handle(
    'gateway:testNvidiaAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.testNvidiaAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:toggleNvidiaAccount',
    safeHandler((_event, accountId: string, enabled: boolean) =>
      withDaemonReload(() => gatewayHubService.toggleNvidiaAccount(accountId, enabled))
    )
  )
  ipcMain.handle(
    'gateway:removeNvidiaAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.removeNvidiaAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:getNvidiaAccountInfo',
    safeHandler((_event, accountId: string) => gatewayHubService.getNvidiaAccountInfo(accountId))
  )
  ipcMain.handle(
    'gateway:refreshNvidiaAccountModels',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.refreshNvidiaAccountModels(accountId))
    )
  )
  ipcMain.handle(
    'gateway:resetNvidiaAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.resetNvidiaAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:setNvidiaAccountStatus',
    safeHandler((_event, accountId: string, status: string, reason?: string) =>
      withDaemonReload(() =>
        gatewayHubService.setNvidiaAccountStatus(accountId, status as AccountStatus, reason)
      )
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
    safeHandler((_event, text: string) =>
      withDaemonReload(() => gatewayHubService.importGptWebAuthJson(text))
    )
  )
  ipcMain.handle(
    'gateway:testGptWebAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.testGptWebAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:toggleGptWebAccount',
    safeHandler((_event, accountId: string, enabled: boolean) =>
      withDaemonReload(() => gatewayHubService.toggleGptWebAccount(accountId, enabled))
    )
  )
  ipcMain.handle(
    'gateway:removeGptWebAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.removeGptWebAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:getGptWebAccountInfo',
    safeHandler((_event, accountId: string) => gatewayHubService.getGptWebAccountInfo(accountId))
  )
  ipcMain.handle(
    'gateway:refreshGptWebAccountModels',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.refreshGptWebAccountModels(accountId))
    )
  )
  ipcMain.handle(
    'gateway:resetGptWebAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.resetGptWebAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:setGptWebAccountStatus',
    safeHandler((_event, accountId: string, status: string, reason?: string) =>
      withDaemonReload(() =>
        gatewayHubService.setGptWebAccountStatus(accountId, status as AccountStatus, reason)
      )
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
    safeHandler((_event, text: string) =>
      withDaemonReload(() => gatewayHubService.importGrokWebAuthJson(text))
    )
  )
  ipcMain.handle(
    'gateway:testGrokWebAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.testGrokWebAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:toggleGrokWebAccount',
    safeHandler((_event, accountId: string, enabled: boolean) =>
      withDaemonReload(() => gatewayHubService.toggleGrokWebAccount(accountId, enabled))
    )
  )
  ipcMain.handle(
    'gateway:removeGrokWebAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.removeGrokWebAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:getGrokWebAccountInfo',
    safeHandler((_event, accountId: string) => gatewayHubService.getGrokWebAccountInfo(accountId))
  )
  ipcMain.handle(
    'gateway:refreshGrokWebAccountModels',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.refreshGrokWebAccountModels(accountId))
    )
  )
  ipcMain.handle(
    'gateway:resetGrokWebAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.resetGrokWebAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:setGrokWebAccountStatus',
    safeHandler((_event, accountId: string, status: string, reason?: string) =>
      withDaemonReload(() =>
        gatewayHubService.setGrokWebAccountStatus(accountId, status as AccountStatus, reason)
      )
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

  // ============== Gemini Web ==============

  ipcMain.handle(
    'gateway:importGeminiWebJson',
    safeHandler((_event, text: string) =>
      withDaemonReload(() => gatewayHubService.importGeminiWebAuthJson(text))
    )
  )
  ipcMain.handle(
    'gateway:testGeminiWebAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.testGeminiWebAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:toggleGeminiWebAccount',
    safeHandler((_event, accountId: string, enabled: boolean) =>
      withDaemonReload(() => gatewayHubService.toggleGeminiWebAccount(accountId, enabled))
    )
  )
  ipcMain.handle(
    'gateway:removeGeminiWebAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.removeGeminiWebAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:getGeminiWebAccountInfo',
    safeHandler((_event, accountId: string) => gatewayHubService.getGeminiWebAccountInfo(accountId))
  )
  ipcMain.handle(
    'gateway:refreshGeminiWebAccountModels',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.refreshGeminiWebAccountModels(accountId))
    )
  )
  ipcMain.handle(
    'gateway:resetGeminiWebAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.resetGeminiWebAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:setGeminiWebAccountStatus',
    safeHandler((_event, accountId: string, status: string, reason?: string) =>
      withDaemonReload(() =>
        gatewayHubService.setGeminiWebAccountStatus(accountId, status as AccountStatus, reason)
      )
    )
  )
  ipcMain.handle(
    'gateway:getGeminiWebSettings',
    safeHandler(() => gatewayHubService.getGeminiWebSettings())
  )
  ipcMain.handle(
    'gateway:updateGeminiWebSettings',
    safeHandler((_event, settings: Record<string, any>) => {
      const filtered = Object.fromEntries(
        Object.entries(settings).filter(([k]) => GEMINI_WEB_KEYS.has(k))
      )
      return gatewayHubService.updateGeminiWebSettings(filtered)
    })
  )

  // ============== Qoder ==============

  ipcMain.handle(
    'gateway:addQoderPersonalAccessToken',
    safeHandler((_event, text: string) =>
      withDaemonReload(() => gatewayHubService.addQoderPersonalAccessToken(text))
    )
  )
  ipcMain.handle(
    'gateway:addQoderCliLogin',
    safeHandler((_event, options?: { label?: string; qoderCliPath?: string }) =>
      withDaemonReload(() => gatewayHubService.addQoderCliLogin(options))
    )
  )
  ipcMain.handle(
    'gateway:detectQoderCli',
    safeHandler((_event, customPath?: string) => gatewayHubService.detectQoderCli(customPath))
  )
  ipcMain.handle(
    'gateway:loginWithQoderCli',
    safeHandler((_event, options?: { cliPath?: string; label?: string }) =>
      gatewayHubService.loginWithQoderCli(options)
    )
  )
  ipcMain.handle(
    'gateway:cancelQoderCliLogin',
    safeHandler(() => gatewayHubService.cancelQoderCliLogin())
  )
  ipcMain.handle(
    'gateway:importQoderJson',
    safeHandler((_event, text: string) =>
      withDaemonReload(() => gatewayHubService.importQoderAuthJson(text))
    )
  )
  ipcMain.handle(
    'gateway:testQoderAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.testQoderAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:toggleQoderAccount',
    safeHandler((_event, accountId: string, enabled: boolean) =>
      withDaemonReload(() => gatewayHubService.toggleQoderAccount(accountId, enabled))
    )
  )
  ipcMain.handle(
    'gateway:removeQoderAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.removeQoderAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:getQoderAccountInfo',
    safeHandler((_event, accountId: string) => gatewayHubService.getQoderAccountInfo(accountId))
  )
  ipcMain.handle(
    'gateway:refreshQoderAccountModels',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.refreshQoderAccountModels(accountId))
    )
  )
  ipcMain.handle(
    'gateway:resetQoderAccount',
    safeHandler((_event, accountId: string) =>
      withDaemonReload(() => gatewayHubService.resetQoderAccount(accountId))
    )
  )
  ipcMain.handle(
    'gateway:setQoderAccountStatus',
    safeHandler((_event, accountId: string, status: string, reason?: string) =>
      withDaemonReload(() =>
        gatewayHubService.setQoderAccountStatus(accountId, status as AccountStatus, reason)
      )
    )
  )
  ipcMain.handle(
    'gateway:getQoderSettings',
    safeHandler(() => gatewayHubService.getQoderSettings())
  )
  ipcMain.handle(
    'gateway:updateQoderSettings',
    safeHandler((_event, settings: Record<string, any>) => {
      const filtered = Object.fromEntries(
        Object.entries(settings).filter(([k]) => QODER_KEYS.has(k))
      )
      return withDaemonReload(() => gatewayHubService.updateQoderSettings(filtered))
    })
  )
  ipcMain.handle(
    'gateway:testRequest',
    safeHandler(async (_event, params: TestRequestParams) => {
      // Issued from the main process to bypass the renderer's browser CORS
      // (the gateway sends no ACAO when bound to 0.0.0.0 / a public host).
      return forwardTestRequest(params)
    })
  )
}

async function getGatewayStatusForUi(): Promise<GatewayStatusSnapshot> {
  const local = await gatewayHubService.getStatus()
  if (local.server.running) return local
  const daemon = await daemonStatus().catch(() => ({ running: false as const }))
  if (!daemon.running) return local
  const daemonStatusSnapshot =
    daemon.serviceStatus && typeof daemon.serviceStatus === 'object'
      ? (daemon.serviceStatus as GatewayStatusSnapshot)
      : local
  const daemonServer = daemonStatusSnapshot.server ?? local.server
  const host = daemon.host ?? daemonServer.host ?? local.server.host
  const port = daemon.port ?? daemonServer.port ?? local.server.port
  return {
    ...daemonStatusSnapshot,
    server: {
      ...daemonServer,
      running: true,
      host,
      port,
      url: `http://${host}:${port}`
    }
  }
}

async function startGatewayForUi(): Promise<GatewayStatusSnapshot> {
  const local = await gatewayHubService.getStatus()
  if (local.server.running) return local
  const daemon = await daemonStatus().catch(() => ({ running: false as const }))
  if (daemon.running) {
    return getGatewayStatusForUi()
  }
  return gatewayHubService.start()
}

async function stopGatewayForUi(): Promise<GatewayStatusSnapshot> {
  const local = await gatewayHubService.getStatus()
  if (local.server.running) return gatewayHubService.stop()
  const daemon = await daemonStatus().catch(() => ({ running: false as const }))
  if (daemon.running) {
    await daemonStop()
    return gatewayHubService.getStatus()
  }
  return gatewayHubService.stop()
}

async function withDaemonReload<T>(action: () => Promise<T>): Promise<T> {
  const result = await action()
  await notifyDaemonReload().catch(() => false)
  return result
}

function makeCodexLoginEmitter(window: BrowserWindow | null): (event: CodexLoginEvent) => void {
  return (event) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send('gateway:codexLoginEvent', event)
    }
  }
}

export interface TestRequestParams {
  url: string
  apiKey: string
  model: string
  prompt: string
  stream: boolean
}

export interface TestRequestResult {
  ok: boolean
  status: number
  statusText: string
  body: string
}

/**
 * Forwards a Quick Test request to the gateway from the main process so the
 * renderer never has to make a cross-origin fetch (the gateway emits no
 * Access-Control-Allow-Origin when bound to a non-loopback host).
 *
 * Streaming responses are reassembled server-side: the SSE `data:` chunks are
 * parsed and their content deltas concatenated, so the renderer receives the
 * final text in one shot.
 */
async function forwardTestRequest(params: TestRequestParams): Promise<TestRequestResult> {
  const res = await fetch(`${params.url.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: params.model,
      messages: [{ role: 'user', content: params.prompt }],
      stream: params.stream
    })
  })
  const ok = res.ok
  const status = res.status
  const statusText = res.statusText
  if (!res.body) {
    const body = await res.text().catch(() => '')
    return { ok, status, statusText, body }
  }
  if (!params.stream) {
    const body = await res.text().catch(() => '')
    return { ok, status, statusText, body }
  }
  // Streaming: walk SSE `data:` lines and concatenate content deltas.
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let acc = ''
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') continue
      try {
        const json = JSON.parse(payload)
        const delta =
          json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content ?? ''
        if (delta) acc += delta
      } catch {
        // ignore non-JSON keepalive / partial lines
      }
    }
  }
  return { ok, status, statusText, body: acc }
}
