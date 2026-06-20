import { join } from 'path'
import { readJsonFile } from '../../core/utils'

/**
 * Candidate locations for the Kiro IDE profile file. The IDE writes the active
 * CodeWhisperer profile ARN here on every login, giving us a machine-local
 * cross-credential identity that survives refresh-token rotation.
 */
export function kiroProfileCandidates(home: string): string[] {
  return [
    join(
      home,
      'Library',
      'Application Support',
      'Kiro',
      'User',
      'globalStorage',
      'kiro.kiroagent',
      'profile.json'
    ),
    join(home, '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'profile.json')
  ]
}

/**
 * Read the profile ARN from the local Kiro IDE profile.json. Returns undefined
 * when the file is absent (e.g. Linux without the IDE) or has no `arn` field.
 * Shared between KiroAuthManager (runtime) and configStore (scan-time dedupe).
 */
export async function readLocalKiroProfileArn(home?: string): Promise<string | undefined> {
  const base = home ?? process.env.HOME ?? process.env.USERPROFILE ?? ''
  for (const path of kiroProfileCandidates(base)) {
    try {
      const data = await readJsonFile<{ arn?: string }>(path)
      if (data?.arn) return data.arn
    } catch {
      // Not found, try next.
    }
  }
  return undefined
}
