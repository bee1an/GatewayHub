import { describe, expect, it } from 'vitest'
import { createCipheriv, createHash, randomBytes } from 'crypto'
import { extractTraeWorkAccountsFromStorage } from '../localState'

// tc storage encryption: tc\x05\x10\x00\x00 header + 32-byte random + AES-128-CBC
// ciphertext of sha512(plaintext) || plaintext. Key/iv derived from
// sha512(sha512(random) || UK^JK). Mirrors providers/trae/localState.
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

function encryptTcValue(plaintext: string): string {
  const random = randomBytes(32)
  const secret = Buffer.alloc(64)
  for (let i = 0; i < 64; i++) secret[i] = UK[i] ^ JK[i]
  const material = Buffer.concat([createHash('sha512').update(random).digest(), secret])
  const expanded = createHash('sha512').update(material).digest()
  const aesKey = expanded.subarray(0, 16)
  const iv = expanded.subarray(16, 32)
  const payload = Buffer.concat([
    createHash('sha512').update(plaintext, 'utf8').digest(),
    Buffer.from(plaintext, 'utf8')
  ])
  const cipher = createCipheriv('aes-128-cbc', aesKey, iv)
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()])
  return Buffer.concat([Buffer.from([0x74, 0x63, 5, 16, 0, 0]), random, encrypted]).toString(
    'base64'
  )
}

describe('traework/localState', () => {
  it('extracts an account from a tc-encrypted storage.json payload', () => {
    const authJson = JSON.stringify({
      token: 'jwt-token-abc',
      refreshToken: 'refresh-xyz',
      expiredAt: '2099-01-01T00:00:00.000Z',
      refreshExpiredAt: '2099-02-01T00:00:00.000Z',
      userId: '2531502394706755',
      host: 'https://api.trae.cn',
      userRegion: { region: 'CN', _aiRegion: 'CN' },
      account: { email: 'user@example.com', username: 'tw-user' }
    })
    const storage: Record<string, unknown> = {
      'iCubeAuthInfo://icube.cloudide': encryptTcValue(authJson),
      'iCubeAuthInfo://icube-dc:1057067962492308': 'dGMFEAAA',
      'telemetry.machineId': 'machine-sha256',
      'telemetry.devDeviceId': '161bea16-3fd8-48ed-a8ae-bc89245c1f8d'
    }
    const accounts = extractTraeWorkAccountsFromStorage(storage)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({
      jwtToken: 'jwt-token-abc',
      refreshToken: 'refresh-xyz',
      userId: '2531502394706755',
      email: 'user@example.com',
      deviceId: '1057067962492308',
      machineId: 'machine-sha256',
      devDeviceId: '161bea16-3fd8-48ed-a8ae-bc89245c1f8d',
      authType: 'traework-local-storage',
      authBaseUrl: 'https://api.trae.cn'
    })
  })

  it('accepts plaintext JSON auth payloads too', () => {
    const storage: Record<string, unknown> = {
      'iCubeAuthInfo://icube.cloudide': JSON.stringify({
        token: 'plain-jwt',
        userId: '42',
        host: 'https://api.trae.cn'
      })
    }
    const accounts = extractTraeWorkAccountsFromStorage(storage)
    expect(accounts[0]?.jwtToken).toBe('plain-jwt')
  })

  it('returns [] when no auth entry exists', () => {
    expect(extractTraeWorkAccountsFromStorage({})).toEqual([])
  })
})
