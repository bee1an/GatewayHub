import { describe, it, expect } from 'vitest'
import { detectUntrustedTap, UNTRUSTED_TAP_RE } from '../updaterTrust'

describe('detectUntrustedTap', () => {
  it('extracts tap name from the real Homebrew error message', () => {
    // 来自 Homebrew trust.rb raise_untrusted! 的真实文本（带尾点）。
    const stderr =
      'Refusing to load cask beelan/gatewayhub from untrusted tap beelan/gatewayhub.\n' +
      'Run `brew trust --cask beelan/gatewayhub` or `brew trust beelan/gatewayhub` to trust it.'
    expect(detectUntrustedTap(stderr)).toBe('beelan/gatewayhub')
  })

  it('does NOT capture the trailing period (regression: \\S+ swallowed the dot)', () => {
    // 旧正则 /untrusted tap\s+(\S+)/i 在这条上会返回 'beelan/gatewayhub.'，
    // 导致 `brew trust beelan/gatewayhub.` 写入错误的 tap 名、重试仍失败。
    const stderr = 'Error: Refusing to load from untrusted tap beelan/gatewayhub.'
    expect(detectUntrustedTap(stderr)).toBe('beelan/gatewayhub')
    expect(detectUntrustedTap(stderr)).not.toMatch(/\.$/)
  })

  it('returns null when stderr does not mention untrusted tap', () => {
    expect(detectUntrustedTap('Error: network unreachable')).toBeNull()
    expect(detectUntrustedTap('')).toBeNull()
  })

  it('does not match the "Untrusted tap:" colon form (different message, no false trust)', () => {
    // tap.rb 里另一条 "Untrusted tap: foo/bar" 带冒号且无空格分隔，
    // 不应被当作可自动信任的触发条件。
    expect(detectUntrustedTap('Warning: Untrusted tap: foo/bar')).toBeNull()
  })

  it('is case-insensitive', () => {
    expect(detectUntrustedTap('UNTRUSTED TAP user/repo.')).toBe('user/repo')
    expect(detectUntrustedTap('Untrusted Tap user/repo.')).toBe('user/repo')
  })

  it('handles multi-line stderr with the error on a later line', () => {
    const stderr =
      '==> Downloading https://example.com/cask\n' +
      'Error: Refusing to load cask beelan/gatewayhub from untrusted tap beelan/gatewayhub.\n' +
      'Run `brew trust --cask beelan/gatewayhub` to trust it.'
    expect(detectUntrustedTap(stderr)).toBe('beelan/gatewayhub')
  })

  it('handles the match spanning a stderr chunk boundary', () => {
    // brew 的 stderr 是按 chunk 到达的，updater 里用 stderrBuf 累积后才匹配，
    // 所以函数拿到的是完整拼接串。这里验证拼接后的跨行文本仍能匹配。
    const chunk1 = 'Refusing to load cask beelan/gatewayhub from untrusted tap '
    const chunk2 = 'beelan/gatewayhub.\nRun `brew trust beelan/gatewayhub` to trust it.'
    expect(detectUntrustedTap(chunk1 + chunk2)).toBe('beelan/gatewayhub')
  })

  it('only matches the first occurrence (single-retry design)', () => {
    const stderr = 'untrusted tap first/tap. then later: untrusted tap second/tap.'
    // 多 tap 串联不在处理范围，只取第一个；retryAfterTrustingTap 只重试一次。
    expect(detectUntrustedTap(stderr)).toBe('first/tap')
  })

  it('regex itself is exported and anchored to the capture group', () => {
    expect(UNTRUSTED_TAP_RE.source).toBe(/untrusted tap\s+([^\s.]+)/i.source)
  })
})
