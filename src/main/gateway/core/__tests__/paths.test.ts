import { describe, it, expect, beforeEach } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'
import { getPaths, resetPathStrategy, setPathStrategy } from '../paths'

describe('paths', () => {
  beforeEach(() => resetPathStrategy())

  it('returns os.homedir() by default', () => {
    expect(getPaths().home()).toBe(homedir())
    expect(getPaths().userData()).toBe(join(homedir(), '.config', 'gatewayhub'))
  })

  it('honours an override strategy', () => {
    setPathStrategy({
      home: () => '/tmp/fake-home',
      userData: () => '/tmp/fake-user-data'
    })
    expect(getPaths().home()).toBe('/tmp/fake-home')
    expect(getPaths().userData()).toBe('/tmp/fake-user-data')
  })

  it('reset restores defaults', () => {
    setPathStrategy({ home: () => '/x', userData: () => '/y' })
    resetPathStrategy()
    expect(getPaths().home()).toBe(homedir())
  })
})
