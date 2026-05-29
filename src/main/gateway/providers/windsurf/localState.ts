import { join } from 'path'
import type { WindsurfAccountConfig } from '../../types'
import { getPaths } from '../../core/paths'
import { buildWindsurfAccountFromInput } from './normalize'

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<any>

export async function scanExternalWindsurfAccounts(): Promise<
  Array<WindsurfAccountConfig & { sourceType: string }>
> {
  const dbPath = join(
    getPaths().home(),
    'Library',
    'Application Support',
    'Windsurf',
    'User',
    'globalStorage',
    'state.vscdb'
  )
  try {
    const sqlite = await dynamicImport('node:sqlite')
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
    try {
      const rows = db
        .prepare(
          "SELECT key, value FROM ItemTable WHERE key IN ('windsurfAuthStatus', 'codeium.windsurf')"
        )
        .all() as Array<{ key: string; value?: string }>
      const values = Object.fromEntries(
        rows.filter((row) => row.value).map((row) => [row.key, safeJson(row.value || '{}')])
      ) as Record<string, any>
      const auth = values.windsurfAuthStatus
      if (!auth?.apiKey) return []
      const storage = values['codeium.windsurf'] || {}
      const email = storage.lastLoginEmail || auth.email
      const account = buildWindsurfAccountFromInput({
        ...auth,
        email,
        label: email || auth.name || 'Windsurf local session',
        apiServerUrl: storage.apiServerUrl,
        inferenceApiServerUrl: storage.inferenceApiServerUrl,
        authType: 'windsurf-local-state'
      })
      return account ? [{ ...account, sourceType: 'windsurf_state' }] : []
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}

function safeJson(value: string): any {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}
