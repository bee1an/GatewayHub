export function formatTokens(n?: number): string {
  if (!n || n <= 0) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function formatCostUsd(n?: number): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '--'
  if (n === 0) return '$0'
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

/** Kiro 网关原生计费单位 credit。小数 < 100 显示两位小数，否则显示整数 */
export function formatCredits(n?: number): string {
  if (n === undefined || n === null || !Number.isFinite(n) || n <= 0) return '0'
  if (n < 100) return n.toFixed(2)
  if (n < 1000) return n.toFixed(0)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}
