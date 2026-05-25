import { autoUpdater } from 'electron-updater'
import { BrowserWindow, ipcMain, app, shell } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join } from 'path'

autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = false
autoUpdater.allowPrerelease = true

let initialized = false
let pendingUpdateVersion: string | null = null
let progressWindow: BrowserWindow | null = null
let fetchChild: ChildProcess | null = null
let upgradeStartedAt = 0
const MIN_PROGRESS_VISIBLE_MS = 800

type ProgressEvent =
  | { kind: 'phase'; phase: 'download' | 'install' | 'error' }
  | { kind: 'log'; text: string }
  | { kind: 'error'; message: string }

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function isBrewInstalled(): boolean {
  if (process.platform !== 'darwin') return false
  const appPath = app.getAppPath()
  let dir = appPath
  for (let i = 0; i < 6; i++) {
    if (dir.endsWith('.app')) break
    dir = dirname(dir)
  }
  if (!dir.endsWith('.app')) return false
  const caskroomCandidates = ['/opt/homebrew/Caskroom/gatewayhub', '/usr/local/Caskroom/gatewayhub']
  return caskroomCandidates.some((p) => existsSync(p))
}

function findBrewBin(): string | null {
  for (const candidate of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function sendProgress(event: ProgressEvent): void {
  const win = progressWindow
  if (!win || win.isDestroyed()) return
  win.webContents.send('upgrade:event', event)
}

function getRendererTarget(): { url?: string; file?: string; search: string } {
  const search = 'view=progress'
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) return { url: `${devUrl}?${search}`, search }
  return { file: join(__dirname, '../renderer/index.html'), search }
}

function openProgressWindow(): void {
  if (progressWindow && !progressWindow.isDestroyed()) {
    progressWindow.focus()
    return
  }
  upgradeStartedAt = Date.now()
  progressWindow = new BrowserWindow({
    width: 380,
    height: 360,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    titleBarStyle: 'hidden',
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  progressWindow.on('ready-to-show', () => progressWindow?.show())
  progressWindow.on('closed', () => {
    progressWindow = null
  })

  const target = getRendererTarget()
  if (target.url) {
    progressWindow.loadURL(target.url)
  } else if (target.file) {
    progressWindow.loadFile(target.file, { search: target.search })
  }
}

function closeProgressWindow(): void {
  if (progressWindow && !progressWindow.isDestroyed()) progressWindow.close()
  progressWindow = null
}

function runBrewFetch(brew: string): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(brew, ['fetch', '--cask', 'gatewayhub'], {
      env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ANALYTICS: '1' }
    })
    fetchChild = child
    let stderrBuf = ''
    child.stdout.on('data', (buf: Buffer) => {
      sendProgress({ kind: 'log', text: buf.toString() })
    })
    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString()
      stderrBuf += text
      sendProgress({ kind: 'log', text })
    })
    child.on('error', (err) => {
      fetchChild = null
      resolve({ ok: false, stderr: err.message })
    })
    child.on('exit', (code) => {
      fetchChild = null
      resolve({ ok: code === 0, stderr: stderrBuf })
    })
  })
}

function spawnDetachedInstallAndQuit(brew: string): void {
  const logDir = app.getPath('logs')
  const logPath = join(logDir, 'brew-upgrade.log')
  const releasesUrl = 'https://github.com/bee1an/GatewayHub/releases/latest'
  const script = [
    '#!/bin/sh',
    `mkdir -p "${logDir}"`,
    `exec >"${logPath}" 2>&1`,
    'sleep 1',
    `if "${brew}" upgrade --cask gatewayhub; then`,
    '  open -a GatewayHub',
    '  exit 0',
    'fi',
    `osascript -e 'display notification "Upgrade failed. Opening Releases page." with title "GatewayHub"'`,
    `open "${releasesUrl}"`
  ].join('\n')

  const sh = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' })
  sh.unref()
  setTimeout(() => app.quit(), 300)
}

async function startBrewUpgrade(): Promise<void> {
  const brew = findBrewBin()
  if (!brew) {
    broadcast('updater:error', 'Homebrew binary not found')
    return
  }

  openProgressWindow()
  sendProgress({ kind: 'phase', phase: 'download' })

  const { ok, stderr } = await runBrewFetch(brew)
  if (!ok) {
    sendProgress({ kind: 'phase', phase: 'error' })
    sendProgress({ kind: 'error', message: stderr.trim() || 'brew fetch failed' })
    return
  }

  const elapsed = Date.now() - upgradeStartedAt
  if (elapsed < MIN_PROGRESS_VISIBLE_MS) {
    await new Promise((r) => setTimeout(r, MIN_PROGRESS_VISIBLE_MS - elapsed))
  }

  sendProgress({ kind: 'phase', phase: 'install' })
  spawnDetachedInstallAndQuit(brew)
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
      void startBrewUpgrade()
    } else {
      openReleasePage(pendingUpdateVersion ?? undefined)
    }
  })
  ipcMain.handle('upgrade:openReleases', () => openReleasePage(pendingUpdateVersion ?? undefined))
  ipcMain.handle('upgrade:cancel', () => {
    if (fetchChild) {
      fetchChild.kill('SIGTERM')
      fetchChild = null
    }
    closeProgressWindow()
  })

  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[updater] check failed:', err)
  })
}
