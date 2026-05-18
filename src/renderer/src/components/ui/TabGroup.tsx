import * as Tabs from '@radix-ui/react-tabs'

interface TabItem {
  value: string
  label: string
  content: React.ReactNode
}

interface TabGroupProps {
  value: string
  onValueChange: (value: string) => void
  items: TabItem[]
  className?: string
}

export function TabGroup({
  value,
  onValueChange,
  items,
  className
}: TabGroupProps): React.JSX.Element {
  return (
    <Tabs.Root value={value} onValueChange={onValueChange} className={className}>
      <Tabs.List className="tab-list mb-4">
        {items.map((item) => (
          <Tabs.Trigger key={item.value} value={item.value} className="tab-trigger">
            {item.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {items.map((item) => (
        <Tabs.Content key={item.value} value={item.value} className="space-y-3 pt-1">
          {item.content}
        </Tabs.Content>
      ))}
    </Tabs.Root>
  )
}
