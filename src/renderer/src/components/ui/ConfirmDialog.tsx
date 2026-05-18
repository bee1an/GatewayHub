import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { Button } from './Button'

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'default' | 'danger'
  onConfirm: () => void
  loading?: boolean
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  variant = 'danger',
  onConfirm,
  loading
}: ConfirmDialogProps): React.JSX.Element {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="modal-overlay" />
        <AlertDialog.Content className="modal-content" style={{ width: '400px' }}>
          <AlertDialog.Title className="section-title">{title}</AlertDialog.Title>
          <AlertDialog.Description className="text-[13px] text-storm mt-2">
            {description}
          </AlertDialog.Description>
          <div className="flex justify-end gap-2 mt-5">
            <AlertDialog.Cancel asChild>
              <Button>{cancelLabel}</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button variant={variant} loading={loading} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
