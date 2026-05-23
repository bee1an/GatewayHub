import { autoUpdater } from 'electron-updater'
import { BrowserWindow, ipcMain, app, shell } from 'electron'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { dirname } from 'path'

autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = false
autoUpdater.allowPrerelease = true

let initialized = false
let pendingUpdateVersion: string | null = null

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function isBrewInstalled(): boolean {
  if (process.platform !== 'darwin') return false
  const appPath = app.getAppPath()
  // app.getAppPath() in production points to .../GatewayHub.app/Contents/Resources/app.asar
  // walk up to find the .app bundle path
  let dir = appPath
  for (let i = 0; i < 6; i++) {
    if (dir.endsWith('.app')) break
    dir = dirname(dir)
  }
  if (!dir.endsWith('.app')) return false
  // brew cask metadata lives at /opt/homebrew/Caskroom/gatewayhub or /usr/local/Caskroom/gatewayhub
  const caskroomCandidates = ['/opt/homebrew/Caskroom/gatewayhub', '/usr/local/Caskroom/gatewayhub']
  return caskroomCandidates.some((p) => existsSync(p))
}

function findBrewBin(): string | null {
  for (const candidate of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function runBrewUpgrade(): void {
  const brew = findBrewBin()
  if (!brew) {
    broadcast('updater:error', 'Homebrew binary not found')
    return
  }
  // Spawn detached terminal that runs brew upgrade --cask gatewayhub then reopens app
  const script = [
    `"${brew}" update`,
    `"${brew}" upgrade --cask gatewayhub`,
    `open -a GatewayHub`
  ].join(' && ')
  // Use osascript to open Terminal so user can see progress and grant any prompts
  const osa = `tell application "Terminal" to do script "${script.replace(/"/g, '\\"')}"`
  spawn('osascript', ['-e', osa], { detached: true, stdio: 'ignore' }).unref()
  setTimeout(() => app.quit(), 500)
}

function openReleasePage(version?: string): void {
  const tag = version ? `v${version}` : ''
  shell.openExternal(
    `https://github.com/bee1an/GatewayHub/releases/${tag ? `tag/${tag}` : 'latest'}`
  )
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
    pendingUpdateVersion = info.version
    broadcast('updater:update-available', {
      version: info.version,
      releaseNotes: info.releaseNotes,
      releaseDate: info.releaseDate,
      installMethod: isBrewInstalled() ? 'brew' : 'manual'
    })
  })

  autoUpdater.on('error', (err) => {
    broadcast('updater:error', err.message)
  })

  ipcMain.handle('updater:check', () => autoUpdater.checkForUpdates())
  ipcMain.handle('updater:install', () => {
    if (process.platform === 'darwin' && isBrewInstalled()) {
      runBrewUpgrade()
    } else {
      openReleasePage(pendingUpdateVersion ?? undefined)
    }
  })

  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[updater] check failed:', err)
  })
}
