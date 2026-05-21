import * as Tooltip from '@radix-ui/react-tooltip'

interface TooltipWrapperProps {
  content: string
  children: React.ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
}

export function TooltipWrapper({
  content,
  children,
  side = 'bottom'
}: TooltipWrapperProps): React.JSX.Element {
  return (
    <Tooltip.Provider delayDuration={300} disableHoverableContent>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side={side}
            sideOffset={4}
            className="pointer-events-none px-2 py-1 rounded-[4px] bg-charcoal text-porcelain text-[12px] font-medium shadow-[var(--shadow-sm)] z-50 animate-in fade-in-0 zoom-in-95 max-w-[280px] break-words"
          >
            {content}
            <Tooltip.Arrow className="fill-charcoal" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}
