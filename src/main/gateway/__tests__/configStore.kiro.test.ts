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

  it('dedupes same-account candidates from multiple sources into one via local profile ARN', async () => {
    // profile.json — machine-local, carries the stable profileArn
    const profilePath = join(
      home,
      'Library',
      'Application Support',
      'Kiro',
      'User',
      'globalStorage',
      'kiro.kiroagent',
      'profile.json'
    )
    await mkdir(dirname(profilePath), { recursive: true })
    await writeFile(
      profilePath,
      JSON.stringify({ arn: 'arn:aws:codewhisperer:us-east-1:123:profile/shared' })
    )

    // kiro-auth-token.json — IDE login, no email, refresh A
    const ssoCache = join(home, '.aws', 'sso', 'cache')
    await mkdir(ssoCache, { recursive: true })
    await writeFile(
      join(ssoCache, 'kiro-auth-token.json'),
      JSON.stringify({
        accessToken: 'access-ide',
        refreshToken: 'refresh-ide',
        expiresAt: '2026-06-01T00:00:00.000Z',
        region: 'us-east-1'
      })
    )

    // account-manager backup — CLI login, has email, refresh B (different session)
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
        activeAccountId: 'acct-1',
        accounts: {
          'acct-1': {
            email: 'user@example.com',
            credentials: {
              accessToken: 'access-cli',
              refreshToken: 'refresh-cli',
              expiresAt: '2026-06-02T00:00:00.000Z',
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

    expect(candidates).toHaveLength(1)
    const c = candidates[0]
    // profileArn backfilled from profile.json onto both sources → merged by profile key
    expect(c.profileArn).toBe('arn:aws:codewhisperer:us-east-1:123:profile/shared')
    // email came from the account-manager source
    expect(c.email).toBe('user@example.com')
    expect(c.label).toBe('user@example.com')
    // tokens taken from the freshest source (account-manager, expiresAt 06-02 > 06-01)
    expect(c.refreshToken).toBe('refresh-cli')
    expect(c.accessToken).toBe('access-cli')
    expect(c.clientId).toBe('client-id')
    expect(c.clientSecret).toBe('client-secret')
    // both sources recorded
    expect(c.sourceType).toContain('account-manager')
    expect(c.sourceType).toContain('json')
    // id derived from the merged profileArn
    expect(c.id).toMatch(/^kiro-profile-/)
  })

  it('keeps different accounts separate when they have distinct emails', async () => {
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
        activeAccountId: 'acct-1',
        accounts: {
          'acct-1': {
            email: 'one@example.com',
            credentials: {
              refreshToken: 'refresh-one',
              accessToken: 'access-one',
              region: 'us-east-1'
            }
          },
          'acct-2': {
            email: 'two@example.com',
            credentials: {
              refreshToken: 'refresh-two',
              accessToken: 'access-two',
              region: 'us-east-1'
            }
          }
        }
      })
    )

    const store = new GatewayConfigStore()
    const candidates = await store.scanExternalAccounts()

    expect(candidates).toHaveLength(2)
    const emails = candidates.map((c) => c.email).sort()
    expect(emails).toEqual(['one@example.com', 'two@example.com'])
  })

  it('merges fields preferring the richest source even without a local profile', async () => {
    // No profile.json — dedupe falls back to email/refresh key.
    // Two sources share the same refresh token (e.g. kiro-auth-token-cli.json ≡ sqlite),
    // one carries email+clientId, the other doesn't.
    const ssoCache = join(home, '.aws', 'sso', 'cache')
    await mkdir(ssoCache, { recursive: true })
    await writeFile(
      join(ssoCache, 'kiro-auth-token.json'),
      JSON.stringify({
        accessToken: 'access-bare',
        refreshToken: 'shared-refresh',
        expiresAt: '2026-06-01T00:00:00.000Z',
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
        activeAccountId: 'acct-1',
        accounts: {
          'acct-1': {
            email: 'rich@example.com',
            credentials: {
              refreshToken: 'shared-refresh',
              accessToken: 'access-rich',
              expiresAt: '2026-06-02T00:00:00.000Z',
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

    // Same refresh token → merged into one
    expect(candidates).toHaveLength(1)
    const c = candidates[0]
    expect(c.email).toBe('rich@example.com')
    expect(c.clientId).toBe('client-id')
    // freshest token wins (06-02)
    expect(c.accessToken).toBe('access-rich')
    expect(c.refreshToken).toBe('shared-refresh')
  })
})
