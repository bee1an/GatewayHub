import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger'
type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  icon?: ReactNode
  iconOnly?: boolean
}

const variantClass: Record<ButtonVariant, string> = {
  default: 'btn',
  primary: 'btn-primary',
  ghost: 'btn-ghost',
  danger: 'btn-danger'
}

const sizeStyles: Record<ButtonSize, string> = {
  xs: 'h-6 px-1.5 text-[12px] gap-1 rounded-[var(--radius-sm)]',
  sm: 'h-7 px-2.5 text-[12px] gap-1',
  md: 'h-8 px-3 text-[13px] gap-1.5',
  lg: 'h-9 px-4 text-[14px] gap-2'
}

const iconOnlySizes: Record<ButtonSize, string> = {
  xs: 'h-6 w-6 p-0',
  sm: 'h-7 w-7 p-0',
  md: 'h-8 w-8 p-0',
  lg: 'h-9 w-9 p-0'
}

const spinnerSizes: Record<ButtonSize, string> = {
  xs: 'w-3 h-3',
  sm: 'w-3 h-3',
  md: 'w-3.5 h-3.5',
  lg: 'w-4 h-4'
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'default',
      size = 'md',
      loading,
      icon,
      iconOnly,
      disabled,
      className,
      children,
      ...props
    },
    ref
  ) => {
    const base = variantClass[variant]
    const dimensions = iconOnly ? iconOnlySizes[size] : sizeStyles[size]
    const spinner = spinnerSizes[size]

    return (
      <button
        ref={ref}
        className={`${base} ${dimensions} ${className ?? ''}`}
        disabled={disabled || loading}
        {...props}
      >
        {loading ? (
          <span className={`i-svg-spinners:ring-resize ${spinner} shrink-0`} />
        ) : icon ? (
          <span className="shrink-0 flex items-center justify-center">{icon}</span>
        ) : null}
        {!iconOnly && children && <span className={loading ? 'opacity-70' : ''}>{children}</span>}
      </button>
    )
  }
)

Button.displayName = 'Button'
