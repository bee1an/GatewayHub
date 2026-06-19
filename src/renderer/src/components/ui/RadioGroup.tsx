import type { KeyboardEvent, ReactNode } from 'react'

export interface RadioOption<T extends string> {
  value: T
  label: ReactNode
  description?: ReactNode
  /** Optional trailing content (e.g. a badge) rendered on the right of the row. */
  trailing?: ReactNode
  disabled?: boolean
}

interface RadioGroupProps<T extends string> {
  value: T
  options: RadioOption<T>[]
  onValueChange: (value: T) => void
  /** id of the element that labels this group, for aria-labelledby. */
  labelledBy?: string
  className?: string
  /** Visually emphasize the selected option's row. Defaults to true. */
  highlightSelected?: boolean
}

/**
 * A vertically-stacked radio group. Each option is a full-width row with a
 * circular radio indicator on the left and an optional description beneath the
 * label — suited to settings where each choice needs a one-line explanation.
 */
export function RadioGroup<T extends string>({
  value,
  options,
  onValueChange,
  labelledBy,
  className,
  highlightSelected = true
}: RadioGroupProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      className={`flex flex-col gap-1.5 ${className ?? ''}`}
    >
      {options.map((option) => {
        const selected = option.value === value
        const isDisabled = option.disabled
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={isDisabled}
            tabIndex={selected ? 0 : -1}
            onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
              const index = options.findIndex((o) => o.value === value)
              if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
                e.preventDefault()
                const next = options[(index + 1) % options.length]
                if (next && !next.disabled) onValueChange(next.value)
              } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
                e.preventDefault()
                const prev = options[(index - 1 + options.length) % options.length]
                if (prev && !prev.disabled) onValueChange(prev.value)
              }
            }}
            onClick={() => {
              if (!isDisabled) onValueChange(option.value)
            }}
            className={`flex items-start gap-2.5 w-full text-left px-3 py-2 rounded-[var(--radius-md)] border transition-colors ${
              selected && highlightSelected
                ? 'border-gunmetal bg-charcoal/40'
                : 'border-charcoal/60 hover:border-gunmetal/70 hover:bg-charcoal/20'
            } ${isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            <RadioDot selected={selected} />
            <span className="flex-1 min-w-0">
              <span className="block text-[12.5px] font-medium text-porcelain leading-snug">
                {option.label}
              </span>
              {option.description && (
                <span className="block text-[11.5px] text-fog mt-0.5 leading-snug">
                  {option.description}
                </span>
              )}
            </span>
            {option.trailing && <span className="shrink-0">{option.trailing}</span>}
          </button>
        )
      })}
    </div>
  )
}

function RadioDot({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden
      className={`mt-[3px] h-4 w-4 shrink-0 rounded-full border flex items-center justify-center transition-colors ${
        selected ? 'border-[var(--c-accent)]' : 'border-gunmetal'
      }`}
    >
      {selected && <span className="h-2 w-2 rounded-full bg-[var(--c-accent)]" />}
    </span>
  )
}
