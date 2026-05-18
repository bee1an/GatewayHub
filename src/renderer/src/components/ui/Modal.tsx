import * as Dialog from '@radix-ui/react-dialog'

interface ModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  width?: string
  showClose?: boolean
  children: React.ReactNode
}

export function Modal({ open, onOpenChange, title, width = '520px', showClose = true, children }: ModalProps): React.JSX.Element {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content" style={{ width }}>
          <div className="flex items-center justify-between mb-4">
            <Dialog.Title className="section-title">{title}</Dialog.Title>
            {showClose && (
              <Dialog.Close className="text-fog hover:text-porcelain transition-colors p-1 rounded-[var(--radius-sm)] hover:bg-charcoal">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M11 3L3 11M3 3l8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </Dialog.Close>
            )}
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
