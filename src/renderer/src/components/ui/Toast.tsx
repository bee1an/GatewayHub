import { useCallback, useRef, useState, type ReactNode } from 'react'
import { ToastContext, type ToastType } from './ToastContext'

type ToastItem = {
  id: number
  message: string
  type: ToastType
  phase: 'visible' | 'exiting'
}

const DURATION = 3000
const EXIT_DURATION = 200

const TYPE_CONFIG: Record<
  ToastType,
  { color: string; accent: string; progress: string; iconPath: React.JSX.Element }
> = {
  success: {
    color: 'text-emerald',
    accent: 'bg-emerald',
    progress: 'bg-emerald/30',
    iconPath: (
      <>
        <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M4.5 7.2L6.2 8.9L9.5 5.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    )
  },
  error: {
    color: 'text-red',
    accent: 'bg-red',
    progress: 'bg-red/30',
    iconPath: (
      <>
        <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5 5l4 4M9 5l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </>
    )
  },
  info: {
    color: 'text-cyan',
    accent: 'bg-cyan',
    progress: 'bg-cyan/30',
    iconPath: (
      <>
        <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" />
        <path d="M7 6.5V10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="7" cy="4.5" r="0.75" fill="currentColor" />
      </>
    )
  }
}

let nextId = 0

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([])
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())

  const clearTimer = useCallback((id: number) => {
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
  }, [])

  const dismiss = useCallback(
    (id: number) => {
      clearTimer(id)
      setItems((prev) =>
        prev.map((t) => (t.id === id && t.phase !== 'exiting' ? { ...t, phase: 'exiting' } : t))
      )
      const exitTimer = setTimeout(() => {
        setItems((prev) => prev.filter((t) => t.id !== id))
        timersRef.current.delete(id)
      }, EXIT_DURATION)
      timersRef.current.set(id, exitTimer)
    },
    [clearTimer]
  )

  const toast = useCallback(
    (message: string, type: ToastType = 'info') => {
      const id = ++nextId
      setItems((prev) => [...prev, { id, message, type, phase: 'visible' }])
      timersRef.current.set(
        id,
        setTimeout(() => dismiss(id), DURATION)
      )
    },
    [dismiss]
  )

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        className="fixed top-4 right-4 flex flex-col gap-2.5 pointer-events-none"
        style={{ zIndex: 9999 }}
      >
        {items.map((item) => {
          const cfg = TYPE_CONFIG[item.type]
          return (
            <div
              key={item.id}
              role="status"
              aria-live={item.type === 'error' ? 'assertive' : 'polite'}
              onClick={() => dismiss(item.id)}
              className="pointer-events-auto relative overflow-hidden min-w-[280px] max-w-[380px] rounded-[var(--radius-md)] bg-graphite/95 backdrop-blur-md border border-charcoal shadow-[rgba(0,0,0,0.4)_0px_8px_24px_0px,rgba(0,0,0,0.2)_0px_2px_8px_0px] px-3.5 py-3"
              style={{
                animation:
                  item.phase === 'exiting'
                    ? `toast-exit ${EXIT_DURATION}ms ease-in forwards`
                    : 'toast-enter 300ms cubic-bezier(0.21, 1.02, 0.73, 1) forwards'
              }}
            >
              <div className={`absolute left-0 top-0 bottom-0 w-[2px] ${cfg.accent}`} />
              <div className="flex items-center gap-2.5">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  fill="none"
                  className={`shrink-0 ${cfg.color}`}
                >
                  {cfg.iconPath}
                </svg>
                <span className="text-[13px] font-[510] text-porcelain">{item.message}</span>
              </div>
              <div
                className="absolute bottom-0 left-0 right-0 h-[2px] overflow-hidden"
                aria-hidden="true"
              >
                <div
                  className={`h-full origin-left ${cfg.progress}`}
                  style={{ animation: `toast-progress ${DURATION}ms linear forwards` }}
                />
              </div>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}
