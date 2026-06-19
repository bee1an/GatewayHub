import { defineConfig, presetWind, presetIcons } from 'unocss'

export default defineConfig({
  presets: [presetWind(), presetIcons({ scale: 1.2 })],
  theme: {
    colors: {
      pitch: 'var(--c-pitch)',
      graphite: 'var(--c-graphite)',
      slate: 'var(--c-slate)',
      charcoal: 'var(--c-charcoal)',
      ash: 'var(--c-ash)',
      gunmetal: 'var(--c-gunmetal)',
      porcelain: 'var(--c-porcelain)',
      steel: 'var(--c-steel)',
      storm: 'var(--c-storm)',
      fog: 'var(--c-fog)',
      alabaster: 'var(--c-alabaster)',
      lime: 'var(--c-lime)',
      'lime-text': 'var(--c-lime-text)',
      accent: 'var(--c-accent)',
      'accent-text': 'var(--c-accent-text)',
      aether: 'var(--c-aether)',
      emerald: 'var(--c-emerald)',
      forest: 'var(--c-forest)',
      red: 'var(--c-red)',
      cyan: 'var(--c-cyan)',
      violet: 'var(--c-violet)',
      amethyst: 'var(--c-amethyst)',
      warning: 'var(--c-warning)'
    },
    fontFamily: {
      sans: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      mono: "'Berkeley Mono', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    },
    animation: {
      keyframes: {
        'fade-in': '{ from { opacity: 0 } to { opacity: 1 } }',
        'slide-up':
          '{ from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: translateY(0) } }',
        'slide-down':
          '{ from { opacity: 0; transform: translateY(-4px) } to { opacity: 1; transform: translateY(0) } }'
      },
      durations: {
        'fade-in': '200ms',
        'slide-up': '250ms',
        'slide-down': '200ms'
      },
      timingFns: {
        'fade-in': 'ease-out',
        'slide-up': 'ease-out',
        'slide-down': 'ease-out'
      },
      counts: {}
    }
  },
  shortcuts: {
    'btn-base':
      'inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-md)] font-medium border outline-none select-none transition-[background-color,color,border-color,transform,filter,box-shadow,opacity] duration-150 ease-out active:not-disabled:scale-[0.97] active:not-disabled:brightness-90 focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--c-lime)_40%,transparent)] focus-visible:ring-offset-1 focus-visible:ring-offset-pitch disabled:opacity-60',
    btn: 'btn-base border-transparent bg-charcoal text-steel hover:not-disabled:bg-gunmetal hover:not-disabled:text-porcelain hover:not-disabled:border-gunmetal',
    'btn-primary':
      'btn-base bg-lime text-lime-text border-[color-mix(in_srgb,var(--c-lime)_20%,transparent)] shadow-[0_1px_2px_rgba(0,0,0,0.15)] hover:not-disabled:bg-[color-mix(in_srgb,var(--c-lime)_85%,transparent)] hover:not-disabled:text-lime-text hover:not-disabled:border-[color-mix(in_srgb,var(--c-lime)_30%,transparent)] hover:not-disabled:shadow-[0_2px_6px_rgba(0,0,0,0.2)]',
    'btn-ghost':
      'btn-base bg-transparent text-storm border-transparent hover:not-disabled:bg-[color-mix(in_srgb,var(--c-charcoal)_70%,transparent)] hover:not-disabled:text-porcelain hover:not-disabled:border-charcoal',
    'btn-danger':
      'btn-base bg-transparent text-red border-[color-mix(in_srgb,var(--c-red)_30%,transparent)] hover:not-disabled:bg-[color-mix(in_srgb,var(--c-red)_10%,transparent)] hover:not-disabled:text-red hover:not-disabled:border-[color-mix(in_srgb,var(--c-red)_50%,transparent)]',
    card: 'rounded-[var(--radius-md)] bg-graphite border border-[color-mix(in_srgb,var(--c-charcoal)_40%,transparent)] shadow-[rgba(255,255,255,0.02)_0_0_0_1px_inset,var(--shadow-sm)] transition-[transform,box-shadow,border-color] duration-200 ease-out hover:border-[color-mix(in_srgb,var(--c-ash)_50%,transparent)] hover:shadow-[rgba(255,255,255,0.03)_0_0_0_1px_inset,rgba(0,0,0,0.5)_0_2px_8px_0]',
    'card-elevated':
      'rounded-[var(--radius-md)] bg-slate border border-[color-mix(in_srgb,var(--c-ash)_40%,transparent)] shadow-[var(--shadow-subtle)] transition-[transform,box-shadow,border-color] duration-200 ease-out',
    'card-nested':
      'rounded-[var(--radius-lg)] bg-pitch p-2 border border-[color-mix(in_srgb,var(--c-charcoal)_60%,transparent)]',
    'input-base':
      'w-full px-3.5 py-3 rounded-[var(--radius-md)] border border-charcoal bg-transparent text-porcelain text-[13px] outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-fog focus:border-gunmetal focus:ring-1 focus:ring-[color-mix(in_srgb,var(--c-gunmetal)_50%,transparent)] focus:shadow-[0_0_8px_rgba(56,59,63,0.15)]',
    'section-title': 'text-[15px] font-[590] text-porcelain tracking-[-0.15px]',
    'section-desc': 'text-[13px] text-storm mt-0.5',
    label: 'text-[12px] font-[590] text-storm uppercase tracking-[0.5px]',
    badge:
      'inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-[var(--radius-sm)+1px] text-[11px] font-medium bg-gunmetal text-storm border border-[color-mix(in_srgb,var(--c-charcoal)_40%,transparent)]',
    tag: 'inline-flex items-center px-1.5 py-0.5 rounded-[var(--radius-sm)] text-[11px] font-medium bg-charcoal text-storm border border-[color-mix(in_srgb,var(--c-ash)_10%,transparent)]',
    'stat-card':
      'rounded-[var(--radius-md)] bg-graphite p-3 border border-[color-mix(in_srgb,var(--c-charcoal)_30%,transparent)] shadow-[var(--shadow-subtle)]',
    'stat-card-lg':
      'rounded-[var(--radius-md)] bg-graphite p-4 border border-[color-mix(in_srgb,var(--c-charcoal)_40%,transparent)] shadow-[var(--shadow-subtle)] flex flex-col gap-1 transition-all duration-200 hover:scale-[1.01] hover:border-[color-mix(in_srgb,var(--c-ash)_40%,transparent)]',
    'stat-card-glow-emerald':
      'stat-card-lg !border-l-[3px] !border-l-emerald shadow-[var(--shadow-glow-emerald)]',
    'stat-card-glow-aether':
      'stat-card-lg !border-l-[3px] !border-l-aether shadow-[var(--shadow-glow-aether)]',
    'stat-card-glow-cyan':
      'stat-card-lg !border-l-[3px] !border-l-cyan shadow-[var(--shadow-glow-cyan)]',
    'stat-card-glow-warning':
      'stat-card-lg !border-l-[3px] !border-l-warning shadow-[var(--shadow-glow-warning)]',
    'stat-card-glow-red':
      'stat-card-lg !border-l-[3px] !border-l-red shadow-[var(--shadow-glow-red)]',
    'stat-card-glow-fog': 'stat-card-lg !border-l-[3px] !border-l-fog opacity-80',
    divider: 'border-t border-charcoal',
    'sidebar-item':
      'flex items-center gap-2.5 px-3 py-1.5 rounded-[var(--radius-md)] text-[13px] text-storm transition-colors duration-100 hover:bg-charcoal hover:text-porcelain',
    'sidebar-item-active':
      'flex items-center gap-2.5 px-3 py-1.5 rounded-[var(--radius-md)] text-[13px] text-porcelain bg-charcoal',
    'log-row':
      'flex items-center gap-3 px-3 py-1.5 text-[13px] font-mono border-b border-[color-mix(in_srgb,var(--c-charcoal)_50%,transparent)] hover:bg-[color-mix(in_srgb,var(--c-slate)_50%,transparent)] transition-colors duration-75',
    'modal-overlay':
      'fixed inset-0 bg-[color-mix(in_srgb,var(--c-pitch)_55%,transparent)] backdrop-blur-md animate-fade-in',
    'modal-content':
      'fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 max-h-[85vh] overflow-y-auto bg-[color-mix(in_srgb,var(--c-graphite)_70%,transparent)] backdrop-blur-xl border border-[color-mix(in_srgb,var(--c-charcoal)_80%,transparent)] rounded-[var(--radius-lg)] shadow-[var(--shadow-xl)] p-5 animate-fade-in',
    'tab-list': 'flex gap-0 bg-charcoal rounded-[var(--radius-md)] p-0.5',
    'tab-trigger':
      'flex-1 px-3 py-1.5 rounded-[var(--radius-sm)] text-[12px] font-medium text-fog transition-colors data-[state=active]:bg-slate data-[state=active]:text-porcelain hover:text-storm outline-none focus-visible:ring-1 focus-visible:ring-accent/60 focus-visible:ring-offset-1 focus-visible:ring-offset-pitch'
  }
})
