import { useCallback, type ReactNode } from 'react'
import { Toaster, toast as sonnerToast } from 'sonner'
import { ToastContext, type ToastType } from './ToastContext'

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const toast = useCallback((message: string, type: ToastType = 'info') => {
    sonnerToast[type](message)
  }, [])

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <Toaster
        position="top-right"
        duration={3000}
        richColors
        closeButton
        toastOptions={{
          classNames: {
            toast:
              '!bg-[var(--glass-bg-strong)] !backdrop-blur-[18px] !border-[var(--glass-border-strong)] !text-porcelain',
            description: '!text-fog',
            closeButton: '!bg-[var(--glass-bg)] !border-[var(--glass-border)] !text-porcelain'
          }
        }}
      />
    </ToastContext.Provider>
  )
}
