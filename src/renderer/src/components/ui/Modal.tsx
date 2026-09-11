import * as Dialog from '@radix-ui/react-dialog'
import { useTranslation } from 'react-i18next'

interface ModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  width?: string
  showClose?: boolean
  children: React.ReactNode
}

export function Modal({
  open,
  onOpenChange,
  title,
  width = '520px',
  showClose = true,
  children
}: ModalProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content" style={{ width }}>
          <div className="flex items-center justify-between mb-4">
            <Dialog.Title className="section-title">{title}</Dialog.Title>
            {showClose && (
              <Dialog.Close
                aria-label={t('common.close') || 'Close'}
                className="text-fog hover:text-porcelain transition-colors p-1 rounded-[var(--radius-sm)] hover:bg-charcoal outline-none focus-visible:ring-1 focus-visible:ring-accent/60 focus-visible:ring-offset-1 focus-visible:ring-offset-pitch"
              >
                <span className="i-ph-x text-[14px] block" aria-hidden="true" />
              </Dialog.Close>
            )}
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
