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
        'pulse-green': '{ 0%, 100% { opacity: 1 } 50% { opacity: 0.4 } }',
        'pulse-red': '{ 0%, 100% { opacity: 1 } 50% { opacity: 0.4 } }',
        'fade-in': '{ from { opacity: 0 } to { opacity: 1 } }',
        'slide-up':
          '{ from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: translateY(0) } }',
        'slide-down':
          '{ from { opacity: 0; transform: translateY(-4px) } to { opacity: 1; transform: translateY(0) } }'
      },
      durations: {
        'pulse-green': '2s',
        'pulse-red': '2s',
        'fade-in': '200ms',
        'slide-up': '250ms',
        'slide-down': '200ms'
      },
      timingFns: {
        'pulse-green': 'ease-in-out',
        'pulse-red': 'ease-in-out',
        'fade-in': 'ease-out',
        'slide-up': 'ease-out',
        'slide-down': 'ease-out'
      },
      counts: {
        'pulse-green': 'infinite',
        'pulse-red': 'infinite'
      }
    }
  },
  shortcuts: {
    btn: 'inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-md)] font-[510] border border-transparent outline-none select-none transition-[background-color,color,border-color,transform,filter,box-shadow,opacity] duration-150 ease-out bg-charcoal text-steel hover:not-disabled:bg-gunmetal hover:not-disabled:text-porcelain hover:not-disabled:border-gunmetal active:not-disabled:scale-[0.97] active:not-disabled:brightness-90 focus-visible:ring-2 focus-visible:ring-lime/40 focus-visible:ring-offset-1 focus-visible:ring-offset-pitch disabled:opacity-35',
    'btn-primary':
      'btn bg-lime text-lime-text border-lime/20 shadow-[0_1px_2px_rgba(0,0,0,0.15)] hover:not-disabled:bg-lime/85 hover:not-disabled:text-lime-text hover:not-disabled:border-lime/30 hover:not-disabled:shadow-[0_2px_6px_rgba(0,0,0,0.2)]',
    'btn-ghost':
      'btn bg-transparent text-storm border-transparent hover:not-disabled:bg-charcoal/70 hover:not-disabled:text-porcelain hover:not-disabled:border-charcoal',
    'btn-danger':
      'btn bg-transparent text-red border-red/30 hover:not-disabled:bg-red/10 hover:not-disabled:text-red hover:not-disabled:border-red/50',
    card: 'rounded-[var(--radius-md)] bg-graphite shadow-[var(--shadow-sm)]',
    'card-elevated': 'rounded-[var(--radius-md)] bg-slate shadow-[var(--shadow-subtle)]',
    'card-nested': 'rounded-[var(--radius-lg)] bg-pitch p-2',
    'input-base':
      'w-full px-3.5 py-3 rounded-[var(--radius-md)] border border-charcoal bg-transparent text-porcelain text-[13px] outline-none transition-colors duration-100 placeholder:text-fog focus:border-gunmetal',
    'section-title': 'text-[15px] font-[510] text-porcelain tracking-[-0.11px]',
    'section-desc': 'text-[13px] text-storm mt-0.5',
    label: 'text-[12px] font-[510] text-storm uppercase tracking-[0.5px]',
    badge:
      'inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-[var(--radius-sm)+2px] text-[12px] font-[510] bg-gunmetal text-storm',
    tag: 'inline-flex items-center px-1.5 py-0.5 rounded-[var(--radius-sm)] text-[12px] font-[510] bg-charcoal text-storm',
    'stat-card': 'rounded-[var(--radius-md)] bg-graphite p-3 shadow-[var(--shadow-subtle)]',
    'stat-card-lg':
      'rounded-[var(--radius-md)] bg-graphite p-4 shadow-[var(--shadow-subtle)] flex flex-col gap-1',
    divider: 'border-t border-charcoal',
    'sidebar-item':
      'flex items-center gap-2.5 px-3 py-1.5 rounded-[var(--radius-md)] text-[13px] text-storm cursor-pointer transition-colors duration-100 hover:bg-charcoal hover:text-porcelain',
    'sidebar-item-active':
      'flex items-center gap-2.5 px-3 py-1.5 rounded-[var(--radius-md)] text-[13px] text-porcelain bg-charcoal cursor-pointer',
    'log-row':
      'flex items-center gap-3 px-3 py-1.5 text-[13px] font-mono border-b border-charcoal/50 hover:bg-slate/50 cursor-pointer transition-colors duration-75',
    'pulse-dot': 'w-2 h-2 rounded-full',
    'pulse-dot-green': 'w-2 h-2 rounded-full bg-emerald animate-pulse-green',
    'pulse-dot-red': 'w-2 h-2 rounded-full bg-red animate-pulse-red',
    'pulse-dot-gray': 'w-2 h-2 rounded-full bg-fog',
    'pulse-dot-warning': 'w-2 h-2 rounded-full bg-warning animate-pulse-red',
    'modal-overlay': 'fixed inset-0 bg-pitch/35 backdrop-blur-sm animate-fade-in',
    'modal-content':
      'fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 max-h-[85vh] overflow-y-auto bg-graphite/95 border border-charcoal rounded-[var(--radius-lg)] shadow-[var(--shadow-xl)] p-5 animate-fade-in',
    'tab-list': 'flex gap-0 bg-charcoal rounded-[var(--radius-md)] p-0.5',
    'tab-trigger':
      'flex-1 px-3 py-1.5 rounded-[var(--radius-sm)] text-[12px] font-[510] text-fog transition-colors data-[state=active]:bg-slate data-[state=active]:text-porcelain hover:text-storm'
  }
})
