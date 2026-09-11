import DOMPurify from 'dompurify'

const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'code',
  'pre',
  'ul',
  'ol',
  'li',
  'a',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'span'
]

export function sanitizeReleaseNotes(html: string): string {
  if (!html) return ''
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href'],
    ALLOWED_URI_REGEXP: /^https?:\/\//i,
    USE_PROFILES: { html: true }
  })
}
