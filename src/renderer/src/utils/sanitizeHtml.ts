const ALLOWED_TAGS = new Set([
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
])

function isEventHandler(name: string): boolean {
  return name.startsWith('on')
}

function sanitizeElement(el: Element, doc: Document): void {
  const children = Array.from(el.children)
  for (const child of children) {
    const tag = child.tagName.toLowerCase()
    if (!ALLOWED_TAGS.has(tag)) {
      // Replace disallowed element with its text content
      const text = doc.createTextNode(child.textContent ?? '')
      child.replaceWith(text)
    } else {
      // Remove disallowed attributes
      const attrs = Array.from(child.attributes)
      for (const attr of attrs) {
        if (isEventHandler(attr.name)) {
          child.removeAttribute(attr.name)
        } else if (tag === 'a') {
          if (attr.name === 'href') {
            if (!/^https?:\/\//.test(attr.value)) {
              child.removeAttribute(attr.name)
            }
          } else {
            child.removeAttribute(attr.name)
          }
        } else {
          child.removeAttribute(attr.name)
        }
      }
      // Recurse into allowed elements
      sanitizeElement(child, doc)
    }
  }
}

export function sanitizeReleaseNotes(html: string): string {
  if (!html) return ''
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')
  sanitizeElement(doc.body, doc)
  return doc.body.innerHTML
}
