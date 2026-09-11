import { parseCookie, stringifyCookie } from 'cookie'

const preserveEncoding = (value: string): string => value

export function normalizeCookieHeader(value: unknown): string {
  if (typeof value !== 'string') return ''
  return serializeCookiePairs(Object.entries(parseCookie(value, { decode: preserveEncoding })))
}

export function serializeCookiePairs(entries: Iterable<readonly [string, unknown]>): string {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim()
    const value = rawValue === null || rawValue === undefined ? '' : String(rawValue).trim()
    const key = name.toLowerCase()
    if (!name || !value || seen.has(key)) continue
    try {
      parts.push(stringifyCookie({ [name]: value }, { encode: preserveEncoding }))
      seen.add(key)
    } catch {
      // Ignore malformed browser-export entries instead of rejecting the whole account.
    }
  }
  return parts.join('; ')
}

export function getCookieValue(cookieHeader: string, name: string): string | undefined {
  const target = name.toLowerCase()
  const cookies = parseCookie(cookieHeader, { decode: preserveEncoding })
  for (const [key, value] of Object.entries(cookies)) {
    if (key.toLowerCase() === target) return value
  }
  return undefined
}
