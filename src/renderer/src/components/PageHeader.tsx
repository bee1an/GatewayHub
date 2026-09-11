interface PageHeaderProps {
  title: string
  desc?: string
  children?: React.ReactNode
}

export function PageHeader({ title, desc, children }: PageHeaderProps): React.JSX.Element {
  return (
    <header className="flex items-end justify-between gap-4 pb-4 border-b border-[color-mix(in_srgb,var(--c-charcoal)_60%,transparent)]">
      <div className="min-w-0">
        <h1 className="text-[19px] font-[650] text-porcelain tracking-[-0.3px] leading-tight">
          {title}
        </h1>
        {desc && <p className="mt-1 text-[11px] font-mono text-fog truncate">{desc}</p>}
      </div>
      {children && <div className="flex items-center gap-2 shrink-0">{children}</div>}
    </header>
  )
}
