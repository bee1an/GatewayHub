// Homebrew 4.x 对第三方 tap 默认不信任，首次使用会报：
//   "Refusing to load cask ... from untrusted tap beelan/gatewayhub.
//    Run `brew trust ...` to trust it."
// 这里检测该错误并自动 trust 后重试，省得用户去终端手动跑。
//
// 捕获组必须排除尾随标点：Homebrew 的错误消息以句点结尾
// ("...from untrusted tap beelan/gatewayhub.")，\S+ 会把句点一起吞掉，
// 导致 `brew trust beelan/gatewayhub.` 把错误的 tap 名写进 trust.json，
// 重试时 Homebrew 仍判定未信任（名字带点不匹配），自动修复静默失效。
// tap 名是 user/repo，永远不含字面 '.'，用 [^\s.]+ 安全。
export const UNTRUSTED_TAP_RE = /untrusted tap\s+([^\s.]+)/i

/** 从 brew 命令的 stderr 中提取未信任的 tap 名，匹配不到返回 null。 */
export function detectUntrustedTap(stderr: string): string | null {
  const match = stderr.match(UNTRUSTED_TAP_RE)
  return match ? match[1] : null
}
