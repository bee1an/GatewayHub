import { autoUpdater } from 'electron-updater'
import { BrowserWindow, ipcMain, app, shell } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'fs'
import { dirname, join } from 'path'
import { is } from '@electron-toolkit/utils'
import { detectUntrustedTap } from './updaterTrust'

autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = false
autoUpdater.allowPrerelease = false

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
  // Only allow dev-update-url.txt override in dev mode
  if (!is.dev && process.env.GATEWAYHUB_DEV_UPDATE !== '1') return
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
// 当前正在运行的 brew 子进程（update/fetch/upgrade/trust 共用）。
// 命名成 activeChild 而非 fetchChild 是因为 trust 步骤也复用它，
// upgrade:cancel IPC 会杀掉它。详见 runBrewUpdate/Fetch/Upgrade/Trust。
let activeChild: ChildProcess | null = null
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
  | { kind: 'phase'; phase: 'download' | 'install' | 'success' | 'error' }
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
    height: 420,
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
    activeChild = child
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
      activeChild = null
      resolve({ ok: false, stderr: err.message })
    })
    child.on('exit', (code) => {
      log('brew update exit code:', code)
      activeChild = null
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
    activeChild = child
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
      activeChild = null
      resolve({ ok: false, stderr: err.message })
    })
    child.on('exit', (code) => {
      log('brew fetch exit code:', code)
      activeChild = null
      resolve({ ok: code === 0, stderr: stderrBuf })
    })
  })
}

function runBrewUpgrade(brew: string): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    log('runBrewUpgrade start', brew)
    sendProgress({ kind: 'log', text: '$ brew upgrade --cask gatewayhub\n' })
    const child = spawn(brew, ['upgrade', '--cask', 'gatewayhub'], {
      env: { ...process.env, HOMEBREW_NO_ANALYTICS: '1' }
    })
    activeChild = child
    let stderrBuf = ''
    child.stdout.on('data', (buf: Buffer) => {
      const text = buf.toString()
      log('brew upgrade stdout:', text.trim())
      sendProgress({ kind: 'log', text })
    })
    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString()
      stderrBuf += text
      log('brew upgrade stderr:', text.trim())
      sendProgress({ kind: 'log', text })
    })
    child.on('error', (err) => {
      log('brew upgrade error event:', err.message)
      activeChild = null
      resolve({ ok: false, stderr: err.message })
    })
    child.on('exit', (code) => {
      log('brew upgrade exit code:', code)
      activeChild = null
      resolve({ ok: code === 0, stderr: stderrBuf })
    })
  })
}

// Homebrew 4.x 对第三方 tap 默认不信任，首次使用会报：
//   "Refusing to load cask ... from untrusted tap beelan/gatewayhub.
//    Run `brew trust ...` to trust it."
// 这里检测该错误并自动 trust 后重试，省得用户去终端手动跑。
// 正则本身已抽到 updaterTrust.ts 并带单测覆盖尾点等边界。
function runBrewTrust(brew: string, tap: string): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    log('runBrewTrust start', brew, tap)
    sendProgress({ kind: 'log', text: `$ brew trust ${tap}\n` })
    // 注意：brew trust 会持久写入 ~/.../homebrew/trust.json（即使后续整体升级失败也不撤销）。
    // 这是必要副作用——要重试就得信任。这里关掉 analytics；不关 HOMEBREW_NO_AUTO_UPDATE
    // 是因为 trust 子命令本身不触发 auto-update，留着与其它 brew 调用环境一致更安全。
    const child = spawn(brew, ['trust', tap], {
      env: { ...process.env, HOMEBREW_NO_ANALYTICS: '1' }
    })
    activeChild = child
    let stderrBuf = ''
    child.stdout.on('data', (buf: Buffer) => {
      const text = buf.toString()
      log('brew trust stdout:', text.trim())
      sendProgress({ kind: 'log', text })
    })
    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString()
      stderrBuf += text
      log('brew trust stderr:', text.trim())
      sendProgress({ kind: 'log', text })
    })
    child.on('error', (err) => {
      log('brew trust error event:', err.message)
      activeChild = null
      resolve({ ok: false, stderr: err.message })
    })
    child.on('exit', (code) => {
      log('brew trust exit code:', code)
      activeChild = null
      resolve({ ok: code === 0, stderr: stderrBuf })
    })
  })
}

/**
 * 若 brew 命令因 tap 未信任失败，自动 trust 后重试一次。
 *
 * 设计取舍：
 * - 只重试一次。多 tap 串联未信任（信任 A 后 rerun 又撞 B）不在处理范围——
 *   GatewayHub 只依赖 beelan/gatewayhub 单 tap，不会出现该场景；若未来加依赖 tap 需扩展成循环。
 * - trust 成功会持久写入 trust.json（即使 rerun 因别的原因失败也不撤销），属必要副作用。
 * - trust 被用户取消（SIGTERM，activeChild 在 cancel IPC 里被 kill）时 stderr 通常为空，
 *   不能返回空 message 让上层显示误导性的 "brew fetch failed"。
 */
async function retryAfterTrustingTap(
  brew: string,
  failed: { ok: boolean; stderr: string },
  rerun: () => Promise<{ ok: boolean; stderr: string }>
): Promise<{ ok: boolean; stderr: string }> {
  const tap = detectUntrustedTap(failed.stderr)
  if (!tap) return failed
  log('detected untrusted tap, trusting then retrying:', tap)
  // 持久副作用提示：trust.json 会被改写，排查时知道环境已变更。
  log('brew trust will persistently modify Homebrew trust list for tap:', tap)
  const trustResult = await runBrewTrust(brew, tap)
  if (!trustResult.ok) {
    // 保留原始 untrusted tap 错误上下文，否则用户只看到 trust 的报错，不知道为何触发 trust。
    // trust 被取消时 stderr 为空，单独标注，避免上层 fallback 到误导性的 "brew fetch failed"。
    const trustErr =
      trustResult.stderr.trim().length > 0
        ? trustResult.stderr.trim()
        : 'brew trust was cancelled or produced no output'
    return {
      ok: false,
      stderr: `${failed.stderr.trim()}\n[brew trust ${tap} failed]\n${trustErr}`
    }
  }
  return rerun()
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

  let fetchResult = await runBrewFetch(brew)
  if (!fetchResult.ok) {
    // 新版 Homebrew 对第三方 tap 默认不信任，首次升级会卡在这里。
    // 检测到 untrusted tap 错误就自动 trust 后重试一次。
    fetchResult = await retryAfterTrustingTap(brew, fetchResult, () => runBrewFetch(brew))
  }
  if (!fetchResult.ok) {
    log('brew fetch failed:', fetchResult.stderr.trim())
    sendProgress({ kind: 'phase', phase: 'error' })
    sendProgress({ kind: 'error', message: fetchResult.stderr.trim() || 'brew fetch failed' })
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

  // 直接在 main 进程内跑 brew upgrade，stdout/stderr 实时推到 progress window。
  // brew 替换 .app 时不会影响已经在内存里的本进程，所以可以一直保持窗口打开
  // 直到升级完成；新 bundle 要等用户主动点 "Restart" 才生效。
  await waitForInstallRendered()
  let upgradeResult = await runBrewUpgrade(brew)
  if (!upgradeResult.ok) {
    upgradeResult = await retryAfterTrustingTap(brew, upgradeResult, () => runBrewUpgrade(brew))
  }
  if (!upgradeResult.ok) {
    log('brew upgrade failed:', upgradeResult.stderr.trim())
    sendProgress({ kind: 'phase', phase: 'error' })
    sendProgress({
      kind: 'error',
      message: upgradeResult.stderr.trim() || 'brew upgrade failed'
    })
    return
  }
  sendProgress({ kind: 'phase', phase: 'success' })
  pendingUpdateVersion = null
  log('brew upgrade succeeded; waiting for user to restart')
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
    pendingUpdateVersion = null
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
    if (activeChild) {
      activeChild.kill('SIGTERM')
      activeChild = null
    }
    if (tailChild) {
      tailChild.kill('SIGTERM')
      tailChild = null
    }
    closeProgressWindow()
  })

  ipcMain.handle('upgrade:restart', () => {
    log('ipc upgrade:restart')
    closeProgressWindow()
    // 必须用 app.relaunch + app.quit，不能用 spawn('open', ...)：
    // 当前 GatewayHub 进程还在运行时，`open .app` 只会激活前台、不启动新进程，
    // 紧接着 app.quit 把唯一实例关掉，结果就是 app 关了没有重启。
    // app.relaunch 注册 atExit 钩子，进程真正退出后才 spawn process.execPath，
    // 而 process.execPath 路径已经被 brew 升级时 mv 替换为新版本二进制。
    app.relaunch()
    app.quit()
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
