/**
 * 集中脱敏：递归遍历对象，对命中敏感键名的值替换为 `***`，对字符串值做正则替换。
 *
 * - 纯函数：不修改入参；返回深拷贝。
 * - 用于日志、事件、状态文件等所有可能落盘 / 跨进程传输的数据。
 */

const REDACTED = '***'

/** 命中即整体替换为 *** 的键名（大小写不敏感） */
const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /^authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /^x-api-key$/i,
  /^api[_-]?key$/i,
  /^apikey$/i,
  /^access[_-]?token$/i,
  /^refresh[_-]?token$/i,
  /^id[_-]?token$/i,
  /^bearer$/i,
  /^secret$/i,
  /^client[_-]?secret$/i,
  /^sso$/i,
  /^aws_session_token$/i
]

/** 字符串值正则替换：顺序敏感，先把宽松的 token 形态替换掉再处理具体片段 */
const STRING_REPLACERS: Array<{ pattern: RegExp; replacement: string }> = [
  // ["']?(refresh|access|id)_token["']?\s*[:=]\s*["']?[A-Za-z0-9._-]+ → $1_token=***
  {
    pattern: /["']?(refresh|access|id)_token["']?\s*[:=]\s*["']?[A-Za-z0-9._-]+/gi,
    replacement: '$1_token=***'
  },
  // Bearer xxx → Bearer ***
  { pattern: /Bearer\s+[A-Za-z0-9._-]+/g, replacement: 'Bearer ***' },
  // OpenRouter API keys
  { pattern: /sk-or-v1-[A-Za-z0-9_-]+/g, replacement: 'sk-or-v1-***' },
  // NVIDIA NIM API keys
  { pattern: /nvapi-[A-Za-z0-9._-]+/g, replacement: 'nvapi-***' },
  // OAuth redirect with code= → 占位
  { pattern: /https?:\/\/[^\s]*\bcode=[^&\s]+/g, replacement: '<oauth-redirect-redacted>' },
  // JWT 形态字符串
  { pattern: /eyJ[A-Za-z0-9._-]{20,}/g, replacement: '***jwt***' }
]

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((re) => re.test(key))
}

/** 仅对字符串值做内容级正则替换（不动键） */
export function redactString(input: string): string {
  let out = input
  for (const { pattern, replacement } of STRING_REPLACERS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

function redactValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactString(value)
  if (typeof value !== 'object') return value

  const ref = value as object
  const cached = seen.get(ref)
  if (cached !== undefined) return cached

  if (Array.isArray(value)) {
    const arr: unknown[] = []
    seen.set(ref, arr)
    for (let i = 0; i < value.length; i++) arr[i] = redactValue(value[i], seen)
    return arr
  }

  // 保留常见非普通对象的原值（避免破坏 Date / Buffer / Error 等）
  if (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Error ||
    (typeof Buffer !== 'undefined' && Buffer.isBuffer(value))
  ) {
    return value
  }

  const out: Record<string, unknown> = {}
  seen.set(ref, out)
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(k)) {
      out[k] = REDACTED
      continue
    }
    out[k] = redactValue(v, seen)
  }
  return out
}

/**
 * 深拷贝并脱敏：
 * - 对命中 SENSITIVE_KEY_PATTERNS 的键，整体替换值为 '***'
 * - 对字符串值应用 STRING_REPLACERS
 * - 不修改入参
 */
export function redactSecrets<T>(value: T): T {
  return redactValue(value, new WeakMap()) as T
}
