import { autoUpdater } from 'electron-updater'
import { BrowserWindow, ipcMain, app, shell } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'fs'
import { dirname, join } from 'path'

autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = false
autoUpdater.allowPrerelease = true

// ===== 日志 =====
// 把 updater 流程的关键事件写到 ~/.../Logs/updater.log，
// 排查用户上报的问题时不再依赖 console（packaged 版没人看 console）。
let logPathCache: string | null = null
function getLogPath(): string {
  if (logPathCache) return logPathCache
  const dir = app.getPath('logs')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // ignore
  }
  logPathCache = join(dir, 'updater.log')
  return logPathCache
}
function log(...parts: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${parts
    .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ')}`
  // 同时写文件 + 控制台，dev 调试也能直接看到
  console.log('[updater]', line)
  try {
    appendFileSync(getLogPath(), line + '\n')
  } catch {
    // ignore disk errors silently
  }
}

// 本地测试入口：如果用户配置目录下存在 dev-update-url.txt，
// 就把更新源切换到该文件中的 URL（generic provider）。
// 文件内容格式：第一行写 URL，例如 http://127.0.0.1:8787/
// 删除文件即可恢复到 GitHub releases 的默认源。
function applyLocalUpdateOverride(): void {
  try {
    const overrideFile = join(app.getPath('userData'), 'dev-update-url.txt')
    if (!existsSync(overrideFile)) return
    const url = readFileSync(overrideFile, 'utf8').trim()
    if (!url) return
    autoUpdater.setFeedURL({ provider: 'generic', url })
    log('using local feed:', url)
  } catch (err) {
    log('failed to apply local override:', (err as Error).message)
  }
}

let initialized = false
let pendingUpdateVersion: string | null = null
let progressWindow: BrowserWindow | null = null
let fetchChild: ChildProcess | null = null
let tailChild: ChildProcess | null = null

// ===== 事件 buffer 时序保证 =====
// 问题：openProgressWindow 后窗口仍在 loadURL，React 还没 mount，
//       此时 main 发的 IPC 消息会被丢。改成 buffer + flush 模式：
//       renderer 监听器注册完毕后通过 'upgrade:ready' 通知 main。
let rendererReady = false
let pendingEvents: ProgressEvent[] = []
let readyAt = 0
let installRenderedResolver: (() => void) | null = null
const MIN_PROGRESS_VISIBLE_MS = 1500
const INSTALL_RENDER_TIMEOUT_MS = process.env['ELECTRON_RENDERER_URL'] ? 3000 : 1500

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
  const found = caskroomCandidates.some((p) => existsSync(p))
  log('isBrewInstalled:', { appPath, dir, found })
  return found
}

function findBrewBin(): string | null {
  for (const candidate of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function sendProgress(event: ProgressEvent): void {
  const win = progressWindow
  if (!win || win.isDestroyed()) {
    log('sendProgress dropped (no window)', event)
    return
  }
  if (!rendererReady) {
    pendingEvents.push(event)
    log('sendProgress buffered', { event, queueSize: pendingEvents.length })
    return
  }
  log('sendProgress live', event)
  win.webContents.send('upgrade:event', event)
}

function flushPendingEvents(): void {
  const win = progressWindow
  if (!win || win.isDestroyed()) {
    pendingEvents = []
    return
  }
  log('flushPendingEvents', { count: pendingEvents.length })
  for (const event of pendingEvents) {
    win.webContents.send('upgrade:event', event)
  }
  pendingEvents = []
}

function getRendererTarget(): { url?: string; file?: string; search: string } {
  const search = 'view=progress'
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) return { url: `${devUrl}?${search}`, search }
  return { file: join(__dirname, '../renderer/index.html'), search }
}

function openProgressWindow(): void {
  if (progressWindow && !progressWindow.isDestroyed()) {
    log('openProgressWindow: reuse existing window')
    progressWindow.focus()
    return
  }
  // 重置时序状态
  rendererReady = false
  pendingEvents = []
  readyAt = 0
  installRenderedResolver = null

  log('openProgressWindow: creating')
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
  progressWindow.on('ready-to-show', () => {
    log('progressWindow ready-to-show')
    progressWindow?.show()
  })
  progressWindow.on('closed', () => {
    log('progressWindow closed')
    progressWindow = null
    rendererReady = false
    pendingEvents = []
  })

  const target = getRendererTarget()
  log('progressWindow load target', target)
  if (target.url) {
    progressWindow.loadURL(target.url)
  } else if (target.file) {
    progressWindow.loadFile(target.file, { search: target.search })
  }
}

function closeProgressWindow(): void {
  log('closeProgressWindow')
  if (progressWindow && !progressWindow.isDestroyed()) progressWindow.close()
  progressWindow = null
  rendererReady = false
  pendingEvents = []
}

function runBrewUpdate(brew: string): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    log('runBrewUpdate start', brew)
    sendProgress({ kind: 'log', text: '$ brew update\n' })
    const child = spawn(brew, ['update', '--quiet'], {
      env: { ...process.env, HOMEBREW_NO_ANALYTICS: '1' }
    })
    fetchChild = child
    let stderrBuf = ''
    child.stdout.on('data', (buf: Buffer) => {
      const text = buf.toString()
      log('brew update stdout:', text.trim())
      sendProgress({ kind: 'log', text })
    })
    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString()
      stderrBuf += text
      log('brew update stderr:', text.trim())
      sendProgress({ kind: 'log', text })
    })
    child.on('error', (err) => {
      log('brew update error event:', err.message)
      fetchChild = null
      resolve({ ok: false, stderr: err.message })
    })
    child.on('exit', (code) => {
      log('brew update exit code:', code)
      fetchChild = null
      resolve({ ok: code === 0, stderr: stderrBuf })
    })
  })
}

function runBrewFetch(brew: string): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    log('runBrewFetch start', brew)
    sendProgress({ kind: 'log', text: '$ brew fetch --cask gatewayhub\n' })
    // 关键：不能再设 HOMEBREW_NO_AUTO_UPDATE，否则 brew 会用旧 tap 缓存判定"已是最新"。
    // 上一步 runBrewUpdate 已经显式刷过 tap，这里只关掉 analytics。
    const child = spawn(brew, ['fetch', '--cask', 'gatewayhub'], {
      env: { ...process.env, HOMEBREW_NO_ANALYTICS: '1' }
    })
    fetchChild = child
    let stderrBuf = ''
    child.stdout.on('data', (buf: Buffer) => {
      const text = buf.toString()
      log('brew fetch stdout:', text.trim())
      sendProgress({ kind: 'log', text })
    })
    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString()
      stderrBuf += text
      log('brew fetch stderr:', text.trim())
      sendProgress({ kind: 'log', text })
    })
    child.on('error', (err) => {
      log('brew fetch error event:', err.message)
      fetchChild = null
      resolve({ ok: false, stderr: err.message })
    })
    child.on('exit', (code) => {
      log('brew fetch exit code:', code)
      fetchChild = null
      resolve({ ok: code === 0, stderr: stderrBuf })
    })
  })
}

function spawnDetachedInstall(brew: string): { logPath: string } {
  const logDir = app.getPath('logs')
  const logPath = join(logDir, 'brew-upgrade.log')
  const releasesUrl = 'https://github.com/bee1an/GatewayHub/releases/latest'
  // 用绝对路径而不是 `open -a GatewayHub`：当系统里同时存在多份带相同 bundle id 的
  // GatewayHub.app（例如 dev 构建产物 dist/mac-arm64/GatewayHub.app）时，
  // `open -a` 会让 LaunchServices 自己挑一份，可能误选旧的开发版本。
  const appPath = '/Applications/GatewayHub.app'
  // 脚本要点：
  // 1. 记录开始时间和当前已装版本，方便事后对比；
  // 2. 升级前再 brew update 一次（detached 后台跑，不阻塞 UI），保证 tap 缓存最新；
  // 3. 输出关键 marker 行 `[gh-marker]` 系列：main 进程的 tail 监听器靠它判定退出 / 失败 / 完成时机；
  // 4. 用 :> 截断 log 文件，避免上次升级的旧日志混入这次的实时尾随。
  const script = [
    '#!/bin/sh',
    `mkdir -p "${logDir}"`,
    `: > "${logPath}"`,
    `exec >>"${logPath}" 2>&1`,
    'echo "=== brew upgrade started at $(date -Iseconds) ==="',
    `BEFORE=$("${brew}" list --cask --versions gatewayhub 2>/dev/null | awk '{print $2}')`,
    'echo "before version: $BEFORE"',
    // 留一段时间让 main 端的 tail 把"准备中"的日志推到 UI；同时让 progressWindow 渲染稳定
    'sleep 2',
    `"${brew}" update --quiet || echo "[warn] brew update failed, continuing"`,
    // 这一行是 main 端"安全 quit"的信号：brew 即将动 .app bundle，必须让 main 进程退出
    'echo "[gh-marker] ready-to-replace"',
    'sleep 1',
    `if "${brew}" upgrade --cask gatewayhub; then`,
    `  AFTER=$("${brew}" list --cask --versions gatewayhub 2>/dev/null | awk '{print $2}')`,
    '  echo "after version: $AFTER"',
    '  if [ "$BEFORE" = "$AFTER" ]; then',
    '    echo "[gh-marker] failed: version unchanged"',
    `    osascript -e 'display notification "Already on latest version reported by Homebrew. Tap may be stale; try \\"brew update\\" manually." with title "GatewayHub"'`,
    `    open "${releasesUrl}"`,
    '    exit 1',
    '  fi',
    '  echo "[gh-marker] success"',
    `  open "${appPath}"`,
    '  exit 0',
    'fi',
    'echo "[gh-marker] failed: brew upgrade exited non-zero"',
    `osascript -e 'display notification "Upgrade failed. Opening Releases page." with title "GatewayHub"'`,
    `open "${releasesUrl}"`
  ].join('\n')

  log('spawnDetachedInstall: script written, log at', logPath)
  const sh = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' })
  sh.unref()
  return { logPath }
}

// 监听 brew-upgrade.log 的实时输出，转发到 progress window，并通过 marker 判定何时 quit。
// 返回一个 promise，resolve 时附带是否需要 main 进程立即 quit 的信号。
function streamBrewUpgradeLog(logPath: string): Promise<{ shouldQuit: boolean }> {
  return new Promise((resolve) => {
    let resolved = false
    let pending = ''
    const finish = (shouldQuit: boolean, reason: string): void => {
      if (resolved) return
      resolved = true
      log('streamBrewUpgradeLog finish:', { shouldQuit, reason })
      try {
        tail.kill('SIGTERM')
      } catch {
        // ignore
      }
      resolve({ shouldQuit })
    }

    log('streamBrewUpgradeLog: tail -F', logPath)
    // -F 在 macOS 上跟随 inode 变化，避免脚本 truncate 后丢日志
    const tail = spawn('/usr/bin/tail', ['-n', '+1', '-F', logPath])
    tailChild = tail

    tail.stdout.on('data', (buf: Buffer) => {
      pending += buf.toString()
      let idx: number
      while ((idx = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, idx)
        pending = pending.slice(idx + 1)
        if (!line) continue

        if (line.startsWith('[gh-marker] ')) {
          const marker = line.slice('[gh-marker] '.length).trim()
          if (marker === 'ready-to-replace') {
            // brew 即将动 .app bundle，main 进程现在必须让出
            sendProgress({ kind: 'log', text: 'Replacing application bundle...\n' })
            finish(true, 'ready-to-replace')
          } else if (marker.startsWith('failed')) {
            sendProgress({ kind: 'phase', phase: 'error' })
            sendProgress({ kind: 'error', message: marker })
            finish(false, marker)
          } else if (marker === 'success') {
            // 实际上 main 在 ready-to-replace 时已经 quit；这里到不了
            finish(false, 'success')
          }
          continue
        }

        sendProgress({ kind: 'log', text: line + '\n' })
      }
    })
    tail.on('error', (err) => {
      log('tail error:', err.message)
      finish(false, 'tail-error')
    })
    tail.on('exit', (code) => {
      log('tail exit:', code)
      finish(false, 'tail-exit')
    })
    // 兜底：万一 marker 一直没出现（脚本卡住或者 tail 没拿到数据），10s 后强制走 quit 流程
    setTimeout(() => finish(true, 'fallback-timeout'), 15000)
  })
}

function waitForInstallRendered(): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false
    const finish = (reason: string): void => {
      if (resolved) return
      resolved = true
      installRenderedResolver = null
      log('waitForInstallRendered resolved by:', reason)
      resolve()
    }
    installRenderedResolver = (): void => finish('renderer-ack')
    setTimeout(() => finish('timeout'), INSTALL_RENDER_TIMEOUT_MS)
  })
}

async function startBrewUpgrade(): Promise<void> {
  log('startBrewUpgrade')
  const brew = findBrewBin()
  if (!brew) {
    log('brew binary not found')
    broadcast('updater:error', 'Homebrew binary not found')
    return
  }

  openProgressWindow()
  sendProgress({ kind: 'phase', phase: 'download' })

  // 必须先 brew update，否则 tap 缓存里 cask 版本号没刷新，
  // 后面 brew upgrade 会以为已是最新版直接放弃。
  const updateResult = await runBrewUpdate(brew)
  if (!updateResult.ok) {
    // brew update 失败不一定阻塞，比如网络抖动；只把错误日志吐出来继续往后走，
    // 让 brew fetch / upgrade 自己再尝试一次。
    log('brew update returned non-zero, continuing:', updateResult.stderr.trim())
  }

  const { ok, stderr } = await runBrewFetch(brew)
  if (!ok) {
    log('brew fetch failed:', stderr.trim())
    sendProgress({ kind: 'phase', phase: 'error' })
    sendProgress({ kind: 'error', message: stderr.trim() || 'brew fetch failed' })
    return
  }

  // 从 renderer ready 时刻开始计算最小可见时间，保证用户至少看得到一帧
  const elapsedSinceReady = readyAt > 0 ? Date.now() - readyAt : 0
  const remaining = MIN_PROGRESS_VISIBLE_MS - elapsedSinceReady
  if (remaining > 0) {
    log('waiting min visible:', remaining)
    await new Promise((r) => setTimeout(r, remaining))
  }

  sendProgress({ kind: 'phase', phase: 'install' })

  // 启动后台 brew upgrade（它会先打 [gh-marker] ready-to-replace 再动 .app），
  // 同时本进程 tail brew-upgrade.log 把实时日志推到 progress window。
  // 在看到 ready-to-replace marker 之前都不 quit，让用户能看到完整日志；
  // 看到 marker 后再 quit，让出 .app 给 brew 替换。
  const { logPath } = spawnDetachedInstall(brew)
  await waitForInstallRendered()
  const { shouldQuit } = await streamBrewUpgradeLog(logPath)
  if (shouldQuit) {
    log('quitting app to let brew upgrade replace bundle')
    app.quit()
  } else {
    log('streaming finished without quit signal (likely error path)')
  }
}

function openReleasePage(version?: string): void {
  const tag = version ? `v${version}` : ''
  const url = `https://github.com/bee1an/GatewayHub/releases/${tag ? `tag/${tag}` : 'latest'}`
  log('openReleasePage', url)
  shell.openExternal(url)
}

export function setupUpdater(_win: BrowserWindow): void {
  if (initialized) {
    log('setupUpdater: re-check')
    applyLocalUpdateOverride()
    autoUpdater.checkForUpdates().catch((err) => {
      log('check failed:', err.message)
    })
    return
  }
  initialized = true

  log('setupUpdater: init', {
    appVersion: app.getVersion(),
    platform: process.platform,
    appPath: app.getAppPath()
  })
  applyLocalUpdateOverride()

  autoUpdater.on('checking-for-update', () => log('checking-for-update'))
  autoUpdater.on('update-available', (info) => {
    log('update-available', {
      version: info.version,
      releaseDate: info.releaseDate,
      hasNotes: !!info.releaseNotes
    })
    pendingUpdateVersion = info.version
    broadcast('updater:update-available', {
      version: info.version,
      releaseNotes: info.releaseNotes,
      releaseDate: info.releaseDate,
      installMethod: isBrewInstalled() ? 'brew' : 'manual'
    })
  })
  autoUpdater.on('update-not-available', (info) => {
    log('update-not-available', { version: info?.version })
  })
  autoUpdater.on('error', (err) => {
    log('autoUpdater error:', err.message)
    broadcast('updater:error', err.message)
  })

  ipcMain.handle('updater:check', () => {
    log('ipc updater:check')
    return autoUpdater.checkForUpdates()
  })
  ipcMain.handle('updater:install', () => {
    log('ipc updater:install', {
      platform: process.platform,
      brewInstalled: isBrewInstalled()
    })
    if (process.platform === 'darwin' && isBrewInstalled()) {
      void startBrewUpgrade()
    } else {
      openReleasePage(pendingUpdateVersion ?? undefined)
    }
  })
  ipcMain.handle('upgrade:openReleases', () => openReleasePage(pendingUpdateVersion ?? undefined))
  ipcMain.handle('upgrade:cancel', () => {
    log('ipc upgrade:cancel')
    if (fetchChild) {
      fetchChild.kill('SIGTERM')
      fetchChild = null
    }
    if (tailChild) {
      tailChild.kill('SIGTERM')
      tailChild = null
    }
    closeProgressWindow()
  })

  // renderer 通知 main：监听器已就绪，可以开始派发事件
  ipcMain.on('upgrade:ready', () => {
    if (rendererReady) {
      log('upgrade:ready ignored (already ready)')
      return
    }
    rendererReady = true
    readyAt = Date.now()
    log('upgrade:ready received', { queued: pendingEvents.length })
    flushPendingEvents()
  })

  // renderer 通知 main：install phase 已经渲染到屏幕，可以安全 quit
  ipcMain.on('upgrade:installRendered', () => {
    log('upgrade:installRendered received')
    installRenderedResolver?.()
  })

  autoUpdater.checkForUpdates().catch((err) => {
    log('initial check failed:', err.message)
  })
}
