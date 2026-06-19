import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'gatewayhub-sidebar-hidden'
// Same-tab sync: the Settings card and the Sidebar are mounted simultaneously,
// so toggling in Settings needs to re-render the Sidebar without a reload.
// localStorage's `storage` event only fires across *other* tabs, so we also
// dispatch a custom event on the same window for in-tab updates.
const CHANGE_EVENT = 'gatewayhub-sidebar-visibility-change'

function readHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((v): v is string => typeof v === 'string'))
  } catch {
    return new Set()
  }
}

function writeHidden(set: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]))
    window.dispatchEvent(new Event(CHANGE_EVENT))
  } catch {
    /* localStorage may be unavailable (private mode) — visibility stays session-only */
  }
}

export function useSidebarVisibility(): {
  hidden: Set<string>
  isVisible: (name: string) => boolean
  toggle: (name: string) => void
  showAll: () => void
} {
  const [hidden, setHidden] = useState<Set<string>>(() => readHidden())

  useEffect(() => {
    const sync = (): void => setHidden(readHidden())
    window.addEventListener(CHANGE_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const toggle = useCallback((name: string) => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      writeHidden(next)
      return next
    })
  }, [])

  const showAll = useCallback(() => {
    if (hidden.size === 0) return
    writeHidden(new Set())
    setHidden(new Set())
  }, [hidden.size])

  const isVisible = useCallback((name: string) => !hidden.has(name), [hidden])

  return { hidden, isVisible, toggle, showAll }
}
