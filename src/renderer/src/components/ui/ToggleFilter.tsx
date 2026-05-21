import * as ToggleGroup from '@radix-ui/react-toggle-group'

interface ToggleFilterProps {
  value: string
  onValueChange: (value: string) => void
  items: { value: string; label: string }[]
}

export function ToggleFilter({
  value,
  onValueChange,
  items
}: ToggleFilterProps): React.JSX.Element {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(v) => {
        if (v) onValueChange(v)
      }}
      className="inline-flex items-center rounded-[6px] bg-graphite p-0.5 gap-0.5 shadow-[var(--shadow-subtle)] w-fit"
    >
      {items.map((item) => (
        <ToggleGroup.Item
          key={item.value}
          value={item.value}
          className="px-2 py-1 rounded-[4px] text-[12px] font-medium transition-colors data-[state=on]:bg-charcoal data-[state=on]:text-porcelain data-[state=off]:text-fog data-[state=off]:hover:text-storm outline-none focus-visible:ring-1 focus-visible:ring-accent/60 focus-visible:ring-offset-1 focus-visible:ring-offset-pitch"
        >
          {item.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}
