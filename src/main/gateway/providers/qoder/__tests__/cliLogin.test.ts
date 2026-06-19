import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importCurrentQoderCliAuth } from '../cliLogin'

describe('qoder/cliLogin', () => {
  let dir: string
  let bin: string
  let sourceHome: string
  let authStoreDir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gatewayhub-qoder-login-'))
    bin = join(dir, 'qodercli')
    sourceHome = join(dir, 'source-home')
    authStoreDir = join(dir, 'managed-auth')
    await mkdir(join(sourceHome, '.qoder', '.auth'), { recursive: true })
    await writeFile(join(sourceHome, '.qoder', '.auth', 'user'), 'encrypted-user-blob', 'utf8')
    await writeFile(join(sourceHome, '.qoder', '.auth', 'machine_id'), 'machine-1', 'utf8')
    await writeFile(
      bin,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "qodercli 1.2.3"
  exit 0
fi
if [ "$1" = "status" ]; then
  if [ -z "$QODER_CLI_HOME" ] || [ ! -f "$QODER_CLI_HOME/.qoder/.auth/user" ] || [ ! -f "$QODER_CLI_HOME/.qoder/.auth/machine_id" ]; then
    echo '{"logged_in":false}'
    exit 0
  fi
  echo '{"logged_in":true,"username":"Qoder User","email":"USER@EXAMPLE.COM","version":"1.2.3"}'
  exit 0
fi
exit 1
`,
      'utf8'
    )
    await chmod(bin, 0o755)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('copies current qodercli auth into a managed per-account home', async () => {
    const account = await importCurrentQoderCliAuth({
      sourceHome,
      authStoreDir,
      qoderCliPath: bin
    })

    expect(account).toMatchObject({
      id: expect.stringMatching(/^qoder-cli-/),
      label: 'user@example.com',
      email: 'user@example.com',
      enabled: true,
      authType: 'qoder-cli-auth',
      qoderCliPath: bin
    })
    expect(account.qoderCliHome?.startsWith(join(authStoreDir, 'qoder-cli-'))).toBe(true)
    await expect(
      readFile(join(account.qoderCliHome!, '.qoder', '.auth', 'user'), 'utf8')
    ).resolves.toBe('encrypted-user-blob')
    await expect(
      readFile(join(account.qoderCliHome!, '.qoder', '.auth', 'machine_id'), 'utf8')
    ).resolves.toBe('machine-1')
  })
})
