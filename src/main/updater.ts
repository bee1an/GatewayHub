import { autoUpdater } from 'electron-updater'
import { BrowserWindow, ipcMain } from 'electron'

autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = false

export function setupUpdater(win: BrowserWindow): void {
  autoUpdater.on('update-available', (info) => {
    win.webContents.send('updater:update-available', {
      version: info.version,
      releaseNotes: info.releaseNotes,
      releaseDate: info.releaseDate
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    win.webContents.send('updater:download-progress', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total
    })
  })

  autoUpdater.on('update-downloaded', () => {
    win.webContents.send('updater:update-downloaded')
  })

  autoUpdater.on('error', (err) => {
    win.webContents.send('updater:error', err.message)
  })

  ipcMain.handle('updater:check', () => autoUpdater.checkForUpdates())
  ipcMain.handle('updater:download', () => autoUpdater.downloadUpdate())
  ipcMain.handle('updater:install', () => autoUpdater.quitAndInstall())

  autoUpdater.checkForUpdates().catch(() => {})
}
