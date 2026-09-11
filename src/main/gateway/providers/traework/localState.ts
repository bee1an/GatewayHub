import { join } from 'path'
import { readdir, readFile, stat } from 'fs/promises'
import type { TraeWorkAccountConfig } from '../../types'
import { getPaths } from '../../core/paths'
import { decryptTraeStorageValue } from '../trae/localState'
import { buildTraeWorkAccountFromInput } from './normalize'

const TRAEWORK_AUTH_STORAGE_KEY = 'iCubeAuthInfo://icube.cloudide'
const TRAEWORK_DEVICE_KEY_PREFIX = 'iCubeAuthInfo://icube-dc:'

export async function scanExternalTraeWorkAccounts(
  dataDir?: string
): Promise<Array<TraeWorkAccountConfig & { sourceType: string }>> {
  const candidates: Array<TraeWorkAccountConfig & { sourceType: string }> = []
  const seen = new Set<string>()
  for (const storagePath of await candidateStorageJsonPaths(dataDir)) {
    try {
      const storage = JSON.parse(await readFile(storagePath, 'utf8')) as Record<string, unknown>
      for (const account of extractTraeWorkAccountsFromStorage(storage, 'traework_storage')) {
        if (seen.has(account.id)) continue
        seen.add(account.id)
        candidates.push(account)
      }
    } catch {
      // ignore unreadable/corrupt storage files
    }
  }
  return candidates
}

export function extractTraeWorkAccountsFromStorage(
  storage: Record<string, unknown>,
  sourceType = 'traework_storage'
): Array<TraeWorkAccountConfig & { sourceType: string }> {
  const userInfo = parseStoredUserInfo(storage[TRAEWORK_AUTH_STORAGE_KEY])
  if (!userInfo) return []
  const deviceId = extractDeviceId(storage)
  const account = buildTraeWorkAccountFromInput({
    jwtToken: userInfo.token,
    refreshToken: userInfo.refreshToken,
    tokenExpiresAt: userInfo.expiredAt,
    refreshExpiresAt: userInfo.refreshExpiredAt,
    userId: userInfo.userId,
    countryCode:
      userInfo.userRegion?._aiRegion ||
      userInfo.userRegion?.region ||
      userInfo.account?.storeRegion ||
      userInfo.account?.storeCountryCode,
    email: userInfo.account?.email,
    label: userInfo.account?.username || 'TraeWork local session',
    authBaseUrl: normalizeTraeWorkAuthHost(userInfo.host),
    authType: 'traework-local-storage',
    deviceId,
    machineId: pickStorageString(storage, 'telemetry.machineId'),
    devDeviceId: pickStorageString(storage, 'telemetry.devDeviceId')
  })
  if (!account) return []
  account.authType = 'traework-local-storage'
  return [{ ...account, sourceType }]
}

function parseStoredUserInfo(raw: unknown): any | undefined {
  if (!raw) return undefined
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return undefined
  for (const candidate of [raw, safeDecrypt(raw)]) {
    if (!candidate) continue
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // try next representation
    }
  }
  return undefined
}

function safeDecrypt(value: string): string | undefined {
  try {
    return decryptTraeStorageValue(value)
  } catch {
    return undefined
  }
}

/** The icube-dc storage key embeds the numeric x-device-id: `iCubeAuthInfo://icube-dc:<id>`. */
function extractDeviceId(storage: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(storage)) {
    if (!key.startsWith(TRAEWORK_DEVICE_KEY_PREFIX)) continue
    const id = key.slice(TRAEWORK_DEVICE_KEY_PREFIX.length).trim()
    if (/^\d{6,}$/.test(id)) return id
  }
  return undefined
}

function pickStorageString(storage: Record<string, unknown>, key: string): string | undefined {
  const value = storage[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeTraeWorkAuthHost(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  try {
    const url = new URL(trimmed)
    if (
      !url.hostname.endsWith('.trae.cn') &&
      !url.hostname.endsWith('.mchost.guru') &&
      !url.hostname.endsWith('.traeapi.us') &&
      !url.hostname.endsWith('.trae.ai')
    ) {
      return undefined
    }
    return url.origin
  } catch {
    return undefined
  }
}

async function candidateStorageJsonPaths(dataDir?: string): Promise<string[]> {
  const home = getPaths().home()
  const paths: string[] = []
  if (dataDir?.trim()) {
    paths.push(join(dataDir.trim(), 'User', 'globalStorage', 'storage.json'))
  }

  // macOS
  const appSupport = join(home, 'Library', 'Application Support')
  paths.push(
    join(appSupport, 'TRAE SOLO CN', 'User', 'globalStorage', 'storage.json'),
    join(appSupport, 'TRAE SOLO', 'User', 'globalStorage', 'storage.json')
  )
  try {
    for (const name of await readdir(appSupport)) {
      if (!/^Trae SOLO/i.test(name)) continue
      paths.push(join(appSupport, name, 'User', 'globalStorage', 'storage.json'))
    }
  } catch {
    // ignore
  }

  // Windows: %APPDATA%/TRAE SOLO CN/User/globalStorage/storage.json
  const appData = process.env.APPDATA
  if (appData) {
    paths.push(
      join(appData, 'TRAE SOLO CN', 'User', 'globalStorage', 'storage.json'),
      join(appData, 'TRAE SOLO', 'User', 'globalStorage', 'storage.json')
    )
  }

  const existing: string[] = []
  for (const path of [...new Set(paths)]) {
    try {
      if ((await stat(path)).isFile()) existing.push(path)
    } catch {
      // ignore
    }
  }
  return existing
}

export const TRAEWORK_LOCAL_STORAGE_KEYS = {
  auth: TRAEWORK_AUTH_STORAGE_KEY,
  deviceKeyPrefix: TRAEWORK_DEVICE_KEY_PREFIX
}
