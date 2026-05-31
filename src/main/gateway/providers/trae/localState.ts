import { createDecipheriv, createHash } from 'crypto'
import { join } from 'path'
import { readdir, readFile, stat } from 'fs/promises'
import type { TraeAccountConfig } from '../../types'
import { getPaths } from '../../core/paths'
import { buildTraeAccountFromInput } from './normalize'

const TRAE_AUTH_STORAGE_KEY = 'iCubeAuthInfo://icube.cloudide'
const TRAE_USER_TAG_STORAGE_KEY = 'iCubeAuthInfo://usertag'

export async function scanExternalTraeAccounts(): Promise<
  Array<TraeAccountConfig & { sourceType: string }>
> {
  const candidates: Array<TraeAccountConfig & { sourceType: string }> = []
  const seen = new Set<string>()
  for (const storagePath of await candidateStorageJsonPaths()) {
    try {
      const storage = JSON.parse(await readFile(storagePath, 'utf8')) as Record<string, unknown>
      const sourceType = storagePath.includes('/Trae/') ? 'trae_storage' : 'trae_storage_alt'
      for (const account of extractTraeAccountsFromStorage(storage, sourceType)) {
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

export function extractTraeAccountsFromStorage(
  storage: Record<string, unknown>,
  sourceType = 'trae_storage'
): Array<TraeAccountConfig & { sourceType: string }> {
  const raw = storage[TRAE_AUTH_STORAGE_KEY]
  const userInfo = parseStoredUserInfo(raw)
  if (!userInfo) return []
  const account = buildTraeAccountFromInput({
    jwtToken: userInfo.token,
    refreshToken: userInfo.refreshToken,
    tokenExpiresAt: userInfo.expiredAt,
    refreshExpiresAt: userInfo.refreshExpiredAt,
    userId: userInfo.userId,
    countryCode:
      userInfo.aiRegion ||
      userInfo.region ||
      userInfo.userRegion?._aiRegion ||
      userInfo.account?.storeRegion ||
      userInfo.account?.storeCountryCode,
    email: userInfo.account?.email,
    label: userInfo.account?.username || 'Trae local session',
    authBaseUrl: normalizeTraeAuthHost(userInfo.host),
    authType: 'trae-local-storage'
  })
  if (!account) return []
  account.authType = 'trae-local-storage'
  return [{ ...account, sourceType }]
}

function parseStoredUserInfo(raw: unknown): any | undefined {
  if (!raw) return undefined
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return undefined
  const candidates = [raw, safeDecryptTraeStorage(raw)]
  for (const candidate of candidates) {
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

function safeDecryptTraeStorage(value: string): string | undefined {
  try {
    return decryptTraeStorageValue(value)
  } catch {
    return undefined
  }
}

function normalizeTraeAuthHost(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  try {
    const url = new URL(trimmed)
    if (!url.hostname.endsWith('.traeapi.us') && !url.hostname.endsWith('.trae.ai')) {
      return undefined
    }
    return url.origin
  } catch {
    return undefined
  }
}

/**
 * Decrypts Trae/VS Code byteCrypto values used by User/globalStorage/storage.json.
 * Current Trae builds often store auth JSON as plain JSON, but older/electron profiles may use
 * this AES-CBC wrapper. Keep it local-only and never log the decrypted value.
 */
export function decryptTraeStorageValue(value: string): string {
  const data = Buffer.from(value, 'base64')
  const keySize = 32
  const headerSize = 6
  const hashSize = 64
  if (data.length <= headerSize + keySize + 16) throw new Error('Invalid Trae storage value')
  if (!isTraeAesHeader(data)) throw new Error('Unsupported Trae storage header')
  const randomKey = data.subarray(headerSize, headerSize + keySize)
  const { aesKey, iv } = deriveAesKey(randomKey)
  const encrypted = data.subarray(headerSize + keySize)
  const decipher = createDecipheriv('aes-128-cbc', aesKey, iv)
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
  if (decrypted.length < hashSize) throw new Error('Invalid Trae storage payload')
  const checksum = decrypted.subarray(0, hashSize)
  const payload = decrypted.subarray(hashSize)
  const expected = sha512(payload)
  if (!checksum.equals(expected)) throw new Error('Trae storage checksum mismatch')
  return payload.toString('utf8')
}

async function candidateStorageJsonPaths(): Promise<string[]> {
  const home = getPaths().home()
  const paths = [
    join(home, 'Library', 'Application Support', 'Trae', 'User', 'globalStorage', 'storage.json'),
    join(
      home,
      'Library',
      'Application Support',
      'Trae Beta',
      'User',
      'globalStorage',
      'storage.json'
    ),
    join(home, '.config', 'Trae', 'User', 'globalStorage', 'storage.json'),
    join(home, '.config', 'trae', 'User', 'globalStorage', 'storage.json')
  ]

  // Windows: %APPDATA%/Trae/User/globalStorage/storage.json
  const appData = process.env.APPDATA
  if (appData) {
    paths.push(join(appData, 'Trae', 'User', 'globalStorage', 'storage.json'))
    paths.push(join(appData, 'Trae Beta', 'User', 'globalStorage', 'storage.json'))
  }

  // Be tolerant of renamed international builds while deliberately avoiding "Trae CN".
  const appSupport = join(home, 'Library', 'Application Support')
  try {
    const names = await readdir(appSupport)
    for (const name of names) {
      if (!/^Trae(?! CN)/i.test(name)) continue
      paths.push(join(appSupport, name, 'User', 'globalStorage', 'storage.json'))
    }
  } catch {
    // ignore
  }

  const unique = [...new Set(paths)]
  const existing: string[] = []
  for (const path of unique) {
    try {
      if ((await stat(path)).isFile()) existing.push(path)
    } catch {
      // ignore
    }
  }
  return existing
}

function isTraeAesHeader(data: Buffer): boolean {
  // byteCrypto AES header: tc\x05\x10\x00\x00
  return (
    data[0] === 116 &&
    data[1] === 99 &&
    data[2] === 5 &&
    data[3] === 16 &&
    data[4] === 0 &&
    data[5] === 0
  )
}

function deriveAesKey(randomKey: Buffer): { aesKey: Buffer; iv: Buffer } {
  const secret = Buffer.alloc(64)
  for (let i = 0; i < 64; i++) secret[i] = UK[i] ^ JK[i]
  const material = Buffer.concat([sha512(randomKey), secret])
  const expanded = sha512(material)
  return { aesKey: expanded.subarray(0, 16), iv: expanded.subarray(16, 32) }
}

function sha512(input: Buffer): Buffer {
  return createHash('sha512').update(input).digest()
}

const UK = Uint8Array.from([
  82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155,
  47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76,
  149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37
])

const JK = Uint8Array.from([
  31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181,
  74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187,
  60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125
])

export const TRAE_LOCAL_STORAGE_KEYS = {
  auth: TRAE_AUTH_STORAGE_KEY,
  userTag: TRAE_USER_TAG_STORAGE_KEY
}
