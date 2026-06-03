import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export const DEFAULT_WINDSURF_MODEL = 'swe-1-6-slow'
export const DEFAULT_WINDSURF_API_SERVER_URL = 'https://server.self-serve.windsurf.com'
export const DEFAULT_WINDSURF_IDE_VERSION = '2.3.15'

export const DEFAULT_WINDSURF_SETTINGS = {
  apiServerUrl: DEFAULT_WINDSURF_API_SERVER_URL,
  inferenceApiServerUrl: 'https://inference.codeium.com',
  languageServerBinaryPath: '',
  codeiumDir: '.codeium/windsurf',
  vpnProxyUrl: '',
  firstTokenTimeoutSeconds: 60,
  streamingReadTimeoutSeconds: 120,
  launchTimeoutSeconds: 20,
  maxRetries: 2,
  detectProxy: true
}

const MACOS_BINARY =
  '/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/bin/language_server_macos_arm'
const MACOS_EXTENSION_DIR = '/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf'

export function normalizeWindsurfModel(model: string): string {
  const trimmed = model.trim()
  return trimmed || DEFAULT_WINDSURF_MODEL
}

export function resolveWindsurfLanguageServerBinary(configuredPath?: string): string {
  if (configuredPath && existsSync(configuredPath)) return configuredPath
  if (process.platform === 'darwin' && process.arch === 'arm64' && existsSync(MACOS_BINARY)) {
    return MACOS_BINARY
  }
  const homeCandidate = join(
    homedir(),
    'Applications',
    'Windsurf.app',
    'Contents',
    'Resources',
    'app',
    'extensions',
    'windsurf',
    'bin',
    process.platform === 'win32' ? 'language_server_windows_x64.exe' : 'language_server_macos_arm'
  )
  if (existsSync(homeCandidate)) return homeCandidate
  return configuredPath || MACOS_BINARY
}

export function resolveWindsurfExtensionDir(): string {
  if (existsSync(MACOS_EXTENSION_DIR)) return MACOS_EXTENSION_DIR
  return join(
    homedir(),
    'Applications',
    'Windsurf.app',
    'Contents',
    'Resources',
    'app',
    'extensions',
    'windsurf'
  )
}
