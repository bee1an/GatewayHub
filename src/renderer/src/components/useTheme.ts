import { useCallback, useEffect, useRef, useState } from 'react'

type Theme = 'light' | 'dark'

function getInitial(): Theme {
  const stored = localStorage.getItem('theme') as Theme | null
  if (stored) return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function commitTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
  localStorage.setItem('theme', theme)
}

export type ThemeToggle = (origin?: { x: number; y: number }) => void

// Apply the new theme to the document. When the View Transitions API is
// available, the attribute swap happens inside a snapshot pair and the NEW
// page is revealed by an expanding circle centered on the click point — the
// new theme "bleeds" outward like a drop of ink. `.theme-transitioning`
// disables per-element color transitions for the duration so they don't
// double-animate underneath the reveal and produce muddy intermediate colors.
//
// NOTE: this must run as a side effect of the click, NOT inside a setState
// updater. Updaters run during render (and twice under StrictMode), so calling
// startViewTransition there either no-ops or double-fires and cancels itself,
// and the snapshot is taken before React commits — old & new snapshots look
// identical and the reveal is invisible.
function applyTheme(theme: Theme, origin: { x: number; y: number }): void {
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => { finished: Promise<void> }
  }
  if (
    typeof doc.startViewTransition === 'function' &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    const root = document.documentElement
    // Radius that covers the farthest viewport corner from the click point, so
    // the clip-path circle fully covers the new snapshot by the end of the
    // animation regardless of where the click landed.
    const { innerWidth: w, innerHeight: h } = window
    const r = Math.hypot(Math.max(origin.x, w - origin.x), Math.max(origin.y, h - origin.y))
    root.style.setProperty('--theme-x', `${origin.x}px`)
    root.style.setProperty('--theme-y', `${origin.y}px`)
    root.style.setProperty('--theme-r', `${r}px`)
    root.classList.add('theme-transitioning')
    const transition = doc.startViewTransition(() => commitTheme(theme))
    transition.finished.finally(() => {
      root.classList.remove('theme-transitioning')
      root.style.removeProperty('--theme-x')
      root.style.removeProperty('--theme-y')
      root.style.removeProperty('--theme-r')
    })
  } else {
    commitTheme(theme)
  }
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(getInitial)
  // Mirror `theme` in a ref so toggle() can read the current value without
  // depending on it (keeps the callback stable) and without putting the
  // view-transition side effect inside a setState updater.
  const themeRef = useRef(theme)
  useEffect(() => {
    themeRef.current = theme
  }, [theme])

  // On mount (and only on mount) write the attribute directly — no snapshot to
  // reveal from. Subsequent theme changes are committed by applyTheme() inside
  // toggle(), so this effect never re-runs the attribute write (which would
  // happen after the view-transition snapshot and pollute the transition).
  useEffect(() => {
    commitTheme(theme)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle: ThemeToggle = useCallback((origin) => {
    const point = origin ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    const next = themeRef.current === 'dark' ? 'light' : 'dark'
    applyTheme(next, point)
    setTheme(next)
  }, [])

  return { theme, toggle }
}
