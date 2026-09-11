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
      className="inline-flex items-center rounded-[var(--radius-sm)] bg-pitch border border-[color-mix(in_srgb,var(--c-charcoal)_60%,transparent)] p-0.5 gap-0.5 w-fit"
    >
      {items.map((item) => (
        <ToggleGroup.Item
          key={item.value}
          value={item.value}
          className="px-2.5 py-1 rounded-[var(--radius-sm)] text-[12px] font-medium transition-colors data-[state=on]:bg-charcoal data-[state=on]:text-porcelain data-[state=off]:text-fog data-[state=off]:hover:text-storm outline-none focus-visible:ring-1 focus-visible:ring-accent/60 focus-visible:ring-offset-1 focus-visible:ring-offset-pitch"
        >
          {item.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}
