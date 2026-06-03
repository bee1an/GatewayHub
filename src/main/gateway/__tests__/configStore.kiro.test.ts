import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GatewayConfigStore } from '../configStore'
import { resetPathStrategy, setPathStrategy } from '../core/paths'

describe('GatewayConfigStore Kiro account discovery', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gatewayhub-kiro-scan-'))
    setPathStrategy({
      home: () => home,
      userData: () => join(home, '.config', 'gatewayhub')
    })
  })

  afterEach(async () => {
    resetPathStrategy()
    await rm(home, { recursive: true, force: true })
  })

  it('discovers active Kiro account-manager backup accounts as AWS SSO OIDC accounts', async () => {
    const backupPath = join(
      home,
      'Library',
      'Application Support',
      'kiro-account-manager',
      'kiro-accounts.backup.json'
    )
    await mkdir(dirname(backupPath), { recursive: true })
    await writeFile(
      backupPath,
      JSON.stringify({
        activeAccountId: 'active-account',
        accounts: {
          'active-account': {
            email: 'USER@EXAMPLE.COM',
            nickname: 'User',
            credentials: {
              refreshToken: 'refresh-token',
              accessToken: 'access-token',
              expiresAt: 1780371164506,
              profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/example',
              clientId: 'client-id',
              clientSecret: 'client-secret',
              region: 'us-east-1'
            }
          }
        }
      })
    )

    const store = new GatewayConfigStore()
    const candidates = await store.scanExternalAccounts()

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      id: expect.stringMatching(/^kiro-profile-/),
      email: 'user@example.com',
      label: 'user@example.com',
      enabled: true,
      refreshToken: 'refresh-token',
      accessToken: 'access-token',
      expiresAt: '2026-06-02T03:32:44.506Z',
      profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/example',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      region: 'us-east-1',
      sourceType: 'account-manager'
    })
  })

  it('marks richer discovered Kiro credentials as updatable when an older account already exists', async () => {
    const accountDir = join(home, '.config', 'gatewayhub', 'kiro', 'accounts')
    await mkdir(accountDir, { recursive: true })
    await writeFile(
      join(accountDir, 'user@example.com.json'),
      JSON.stringify({
        id: 'kiro-refresh-existing',
        email: 'user@example.com',
        enabled: true,
        refreshToken: 'refresh-token',
        region: 'us-east-1'
      })
    )

    const backupPath = join(
      home,
      'Library',
      'Application Support',
      'kiro-account-manager',
      'kiro-accounts.backup.json'
    )
    await mkdir(dirname(backupPath), { recursive: true })
    await writeFile(
      backupPath,
      JSON.stringify({
        activeAccountId: 'active-account',
        accounts: {
          'active-account': {
            email: 'user@example.com',
            credentials: {
              refreshToken: 'refresh-token',
              clientId: 'client-id',
              clientSecret: 'client-secret',
              region: 'us-east-1'
            }
          }
        }
      })
    )

    const store = new GatewayConfigStore()
    const { candidates } = await store.scanKiroAccounts()

    expect(candidates[0]).toMatchObject({
      existing: true,
      existingAccountId: 'kiro-refresh-existing',
      updatable: true,
      clientId: 'client-id',
      clientSecret: 'client-secret'
    })
  })

  it('preserves concurrent read-modify-write updates to the same account file', async () => {
    const accountDir = join(home, '.config', 'gatewayhub', 'kiro', 'accounts')
    const accountPath = join(accountDir, 'user@example.com.json')
    await mkdir(accountDir, { recursive: true })
    await writeFile(
      accountPath,
      JSON.stringify({
        id: 'kiro-concurrent',
        email: 'user@example.com',
        enabled: true,
        refreshToken: 'refresh-token'
      })
    )

    const storeA = new GatewayConfigStore()
    const storeB = new GatewayConfigStore()
    await Promise.all([
      storeA.updateAccountFile('kiro-concurrent', { accessToken: 'access-token-a' }),
      storeB.updateAccountFile('kiro-concurrent', { expiresAt: '2026-06-02T12:00:00.000Z' })
    ])

    const persisted = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(persisted).toMatchObject({
      id: 'kiro-concurrent',
      refreshToken: 'refresh-token',
      accessToken: 'access-token-a',
      expiresAt: '2026-06-02T12:00:00.000Z'
    })
  })
})
