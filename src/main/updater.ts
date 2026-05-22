import { autoUpdater } from 'electron-updater'
import { BrowserWindow, ipcMain } from 'electron'

autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true
autoUpdater.allowPrerelease = true

let initialized = false

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function setupUpdater(_win: BrowserWindow): void {
  if (initialized) {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[updater] check failed:', err)
    })
    return
  }
  initialized = true

  autoUpdater.on('update-available', (info) => {
    broadcast('updater:update-available', {
      version: info.version,
      releaseNotes: info.releaseNotes,
      releaseDate: info.releaseDate
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    broadcast('updater:download-progress', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total
    })
  })

  autoUpdater.on('update-downloaded', () => {
    broadcast('updater:update-downloaded')
  })

  autoUpdater.on('error', (err) => {
    broadcast('updater:error', err.message)
  })

  ipcMain.handle('updater:check', () => autoUpdater.checkForUpdates())
  ipcMain.handle('updater:download', () => autoUpdater.downloadUpdate())
  ipcMain.handle('updater:install', () => autoUpdater.quitAndInstall(false, true))

  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[updater] check failed:', err)
  })
}
