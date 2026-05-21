import { homedir } from 'os'
import { join } from 'path'

export interface PathStrategy {
  home(): string
  userData(): string
}

function createDefaultStrategy(): PathStrategy {
  return {
    home: () => homedir(),
    userData: () => join(homedir(), '.config', 'gatewayhub')
  }
}

let current: PathStrategy = createDefaultStrategy()

export function setPathStrategy(strategy: PathStrategy): void {
  current = strategy
}

export function getPaths(): PathStrategy {
  return current
}

export function resetPathStrategy(): void {
  current = createDefaultStrategy()
}
