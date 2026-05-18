import { createContext, useContext } from 'react'

export type ToastType = 'success' | 'error' | 'info'

export type ToastContextValue = {
  toast: (message: string, type?: ToastType) => void
}

export const ToastContext = createContext<ToastContextValue>({ toast: () => {} })

export function useToast(): ToastContextValue {
  return useContext(ToastContext)
}
