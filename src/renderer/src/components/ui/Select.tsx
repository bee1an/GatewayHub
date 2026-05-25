import * as SelectPrimitive from '@radix-ui/react-select'
import { forwardRef } from 'react'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

interface SelectProps {
  value: string
  onValueChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  disabled?: boolean
  error?: boolean
  size?: 'sm' | 'md'
  className?: string
  mono?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export const Select = forwardRef<HTMLButtonElement, SelectProps>(
  (
    {
      value,
      onValueChange,
      options,
      placeholder = '—',
      disabled,
      error,
      size = 'md',
      className,
      mono,
      open,
      onOpenChange
    },
    ref
  ) => {
    const sizeClass = size === 'sm' ? '!py-1 !text-[12px]' : '!py-1.5 !text-[12px]'
    const errorClass = error ? '!border-red/60 shadow-[0_0_6px_rgba(235,87,87,0.15)]' : ''
    const monoClass = mono ? 'font-mono' : ''

    return (
      <SelectPrimitive.Root
        value={value || undefined}
        onValueChange={onValueChange}
        disabled={disabled}
        open={open}
        onOpenChange={onOpenChange}
      >
        <SelectPrimitive.Trigger
          ref={ref}
          className={`input-base w-full ${sizeClass} ${monoClass} ${errorClass} flex items-center justify-between gap-1.5 ${className ?? ''}`}
        >
          <SelectPrimitive.Value placeholder={placeholder} />
          <SelectPrimitive.Icon className="text-fog shrink-0">
            <span className="i-ph-caret-down text-[11px]" aria-hidden="true" />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>

        <SelectPrimitive.Portal>
          <SelectPrimitive.Content
            position="popper"
            sideOffset={4}
            className="z-50 min-w-[var(--radix-select-trigger-width)] max-h-[240px] overflow-hidden rounded-[var(--radius-md)] bg-slate border border-charcoal shadow-[var(--shadow-xl)] animate-in fade-in-0 zoom-in-95"
          >
            <SelectPrimitive.Viewport className="p-1">
              {options.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} disabled={opt.disabled} mono={mono}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectPrimitive.Viewport>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    )
  }
)

Select.displayName = 'Select'

function SelectItem({
  children,
  value,
  disabled,
  mono
}: {
  children: React.ReactNode
  value: string
  disabled?: boolean
  mono?: boolean
}): React.JSX.Element {
  return (
    <SelectPrimitive.Item
      value={value}
      disabled={disabled}
      className={`relative flex items-center px-2 py-1.5 rounded-[var(--radius-sm)] text-[12px] text-steel outline-none select-none cursor-default data-[highlighted]:bg-charcoal data-[highlighted]:text-porcelain data-[disabled]:opacity-40 data-[disabled]:pointer-events-none ${mono ? 'font-mono' : ''}`}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="ml-auto pl-2">
        <span className="i-ph-check text-[11px] text-accent" aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}
