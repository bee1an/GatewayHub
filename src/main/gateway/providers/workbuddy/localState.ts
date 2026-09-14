import { join } from 'path'
import { readdir, readFile, stat } from 'fs/promises'
import type { WorkBuddyAccountConfig } from '../../types'
import { getPaths } from '../../core/paths'
import { buildWorkBuddyAccountFromInput } from './normalize'

const NON_CHAT_MODEL_TAGS = new Set(['text-to-image', 'image-to-image', 'text-to-video'])
const INTERNAL_MODEL_HINTS = ['completion', 'rewrite', 'jump', 'codewise']

/**
 * WorkBuddy desktop credentials live in plain JSON under
 * CodeBuddyExtension/Data/Public/auth/*.info (session.auth + session.account).
 */
export async function scanExternalWorkBuddyAccounts(
  dataDir?: string
): Promise<Array<WorkBuddyAccountConfig & { sourceType: string }>> {
  const candidates: Array<WorkBuddyAccountConfig & { sourceType: string }> = []
  const seen = new Set<string>()
  for (const dir of await candidateAuthDirs(dataDir)) {
    let names: string[] = []
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith('.info'))
    } catch {
      continue
    }
    for (const name of names.sort()) {
      const path = join(dir, name)
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8'))
        const account = buildWorkBuddyAccountFromInput(parsed)
        if (!account || seen.has(account.id)) continue
        seen.add(account.id)
        candidates.push({ ...account, path, sourceType: 'workbuddy_auth_file' })
      } catch {
        // ignore unreadable/corrupt auth files
      }
    }
  }
  return candidates
}

/**
 * Reads the WorkBuddy product.json model catalog (cli/product.json inside the
 * app bundle). Returns chat-capable model ids; [] when unavailable.
 */
export async function loadWorkBuddyProductModels(productJsonPath?: string): Promise<string[]> {
  for (const path of candidateProductJsonPaths(productJsonPath)) {
    try {
      const data = JSON.parse(await readFile(path, 'utf8'))
      const models = extractChatModelIds(data)
      if (models.length) return models
    } catch {
      // try next candidate
    }
  }
  return []
}

export function extractChatModelIds(data: any): string[] {
  const list = Array.isArray(data?.models) ? data.models : []
  const out: string[] = []
  for (const model of list) {
    const id = typeof model?.id === 'string' ? model.id.trim() : ''
    if (!id) continue
    const tags = Array.isArray(model.tags) ? model.tags : []
    if (tags.some((tag: unknown) => typeof tag === 'string' && NON_CHAT_MODEL_TAGS.has(tag)))
      continue
    if (model.vendor === 'tencent') continue
    const lower = id.toLowerCase()
    if (INTERNAL_MODEL_HINTS.some((hint) => lower.includes(hint))) continue
    out.push(id)
  }
  return [...new Set(out)]
}

async function candidateAuthDirs(dataDir?: string): Promise<string[]> {
  const home = getPaths().home()
  const dirs: string[] = []
  if (dataDir?.trim()) {
    const base = dataDir.trim()
    dirs.push(join(base, 'Data', 'Public', 'auth'), join(base, 'auth'), base)
  }
  if (process.platform === 'darwin') {
    dirs.push(
      join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
    )
  } else if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    dirs.push(join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth'))
  } else {
    const xdg = process.env.XDG_DATA_HOME || join(home, '.local', 'share')
    dirs.push(join(xdg, 'CodeBuddyExtension', 'Data', 'Public', 'auth'))
  }
  const existing: string[] = []
  for (const dir of [...new Set(dirs)]) {
    try {
      if ((await stat(dir)).isDirectory()) existing.push(dir)
    } catch {
      // ignore
    }
  }
  return existing
}

function candidateProductJsonPaths(productJsonPath?: string): string[] {
  const home = getPaths().home()
  const paths: string[] = []
  if (productJsonPath?.trim()) paths.push(productJsonPath.trim())
  if (process.platform === 'darwin') {
    paths.push(
      '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/product.json',
      '/Applications/WorkBuddy.app/Contents/Resources/app.asar/cli/product.json'
    )
  } else if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    paths.push(
      join(local, 'Programs', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'product.json')
    )
  } else {
    paths.push(
      '/opt/WorkBuddy/resources/app.asar.unpacked/cli/product.json',
      join(home, '.local', 'share', 'WorkBuddy', 'cli', 'product.json')
    )
  }
  return [...new Set(paths)]
}
