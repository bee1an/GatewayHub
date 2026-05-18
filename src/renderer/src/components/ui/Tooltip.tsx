import * as Tooltip from '@radix-ui/react-tooltip'

interface TooltipWrapperProps {
  content: string
  children: React.ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
}

export function TooltipWrapper({ content, children, side = 'bottom' }: TooltipWrapperProps): React.JSX.Element {
  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          {children}
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side={side}
            sideOffset={4}
            className="px-2 py-1 rounded-[4px] bg-charcoal text-porcelain text-[12px] font-[510] shadow-[var(--shadow-sm)] z-50 animate-in fade-in-0 zoom-in-95"
          >
            {content}
            <Tooltip.Arrow className="fill-charcoal" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}
