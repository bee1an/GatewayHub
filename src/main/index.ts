import { app, shell, BrowserWindow, ipcMain, session } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { gatewayHubService } from './gateway/service'
import { registerGatewayIpc } from './gateway/ipc'
import { setPathStrategy } from './gateway/core/paths'
import { setCliLoginSink } from './gateway/events/cliLoginEvents'
import { setupUpdater } from './updater'
import icon from '../../resources/icon.png?asset'

setPathStrategy({
  home: () => app.getPath('home'),
  userData: () => app.getPath('userData')
})

setCliLoginSink({
  emit: (event) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.webContents.send('gateway:cliLoginOutput', event)
  }
})

// ===== 单实例锁 =====
// 必须在 app.whenReady() 之前注册，否则第二个实例已经把 IPC handler 重复注册一遍。
// dev 模式跳过，允许与正式环境共存。
if (!import.meta.env.DEV && !app.requestSingleInstanceLock()) {
  app.exit(0)
}
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

// ===== app:version 同步 IPC =====
// preload 用 sendSync('app:version') 在 contextBridge 暴露同步 appVersion。
// 必须在模块顶层注册（renderer 进程在 app.whenReady 之前就可能 spawn 起来），
// 不能放到 whenReady 回调里，否则首屏可能拿到 undefined。
ipcMain.on('app:version', (e) => {
  e.returnValue = app.getVersion()
})
ipcMain.handle('app:version', () => app.getVersion())

function applyContentSecurityPolicy(): void {
  // 生产环境收紧 CSP；dev 兼容 vite HMR 的 ws/eval。
  const baseDirectives = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://img.logo.dev",
    "connect-src 'self'",
    "font-src 'self' data:"
  ]
  const devDirectives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:* ws://localhost:*",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://img.logo.dev",
    "connect-src 'self' http://localhost:* ws://localhost:*",
    "font-src 'self' data:"
  ]
  const csp = (is.dev ? devDirectives : baseDirectives).join('; ')
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders }
    // 移除潜在的旧 CSP 头（大小写都可能出现）
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-security-policy') delete headers[key]
    }
    headers['Content-Security-Policy'] = [csp]
    callback({ responseHeaders: headers })
  })
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 960,
    height: 700,
    // Show immediately: the splash screen lives inside index.html and must be
    // visible during the (slow in dev) Vite module-graph compilation. Waiting
    // for ready-to-show would skip the splash entirely because ready-to-show
    // fires only after the first non-empty paint, which in dev happens after
    // the module graph is ready and React has rendered. The background color
    // matches the splash so there is no white flash before the HTML parses.
    backgroundColor: '#08090a',
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 12, y: 12 },
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 开启 sandbox：preload 仅使用 electron API（contextBridge / ipcRenderer），
      // 不依赖任何 require / Node 原生模块，因此 sandbox: true 安全且推荐。
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (!is.dev) setupUpdater(mainWindow)
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url)
      if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(url)
    } catch {
      // ignore malformed URL
    }
    return { action: 'deny' }
  })

  // 仅允许导航到 dev 的 vite URL 或当前打包后的 file://，其它一律拦截。
  mainWindow.webContents.on('will-navigate', (event, navUrl) => {
    try {
      const target = new URL(navUrl)
      const devBase = process.env['ELECTRON_RENDERER_URL']
      if (is.dev && devBase) {
        const dev = new URL(devBase)
        if (target.origin === dev.origin) return
      }
      if (target.protocol === 'file:') return
    } catch {
      // fallthrough -> deny
    }
    event.preventDefault()
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id (与 electron-builder.yml 的 appId 对齐)
  electronApp.setAppUserModelId('dev.gatewayhub.app')

  applyContentSecurityPolicy()

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  registerGatewayIpc()
  gatewayHubService
    .initialize()
    .catch((error) => console.error('GatewayHub initialization failed:', error))

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// ===== 进程级异常兜底 =====
// 写日志失败本身不能再抛错，否则会循环。
process.on('uncaughtException', (err) => {
  try {
    console.error('[main] uncaughtException:', err)
  } catch {
    // ignore
  }
})
process.on('unhandledRejection', (reason) => {
  try {
    console.error('[main] unhandledRejection:', reason)
  } catch {
    // ignore
  }
})
app.on('render-process-gone', (_event, win, details) => {
  try {
    console.error('[main] render-process-gone:', details)
  } catch {
    // ignore
  }
  if (details.reason !== 'clean-exit' && win && !win.isDestroyed()) {
    try {
      win.reload()
    } catch {
      // ignore
    }
  }
})
app.on('child-process-gone', (_event, details) => {
  try {
    console.error('[main] child-process-gone:', details)
  } catch {
    // ignore
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
