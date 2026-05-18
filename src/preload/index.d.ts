import { ElectronAPI } from '@electron-toolkit/preload'

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
