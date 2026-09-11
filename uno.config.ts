import { defineConfig, presetWind3, presetIcons } from 'unocss'

export default defineConfig({
  presets: [presetWind3(), presetIcons({ scale: 1.2 })],
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
      sans: "'Geist', 'PingFang SC', 'Microsoft YaHei', ui-sans-serif, system-ui, -apple-system, sans-serif",
      mono: "'Geist Mono', 'PingFang SC', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
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
      'inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-sm)] font-medium border outline-none select-none transition-colors duration-150 ease-out active:not-disabled:brightness-90 focus-visible:ring-1 focus-visible:ring-accent/70 focus-visible:ring-offset-1 focus-visible:ring-offset-pitch disabled:opacity-50',
    btn: 'btn-base border-charcoal bg-transparent text-steel hover:not-disabled:border-ash hover:not-disabled:text-porcelain hover:not-disabled:bg-graphite',
    'btn-primary':
      'btn-base bg-accent text-accent-text border-transparent font-semibold hover:not-disabled:brightness-110 active:not-disabled:brightness-95',
    'btn-ghost':
      'btn-base bg-transparent text-storm border-transparent hover:not-disabled:bg-charcoal/60 hover:not-disabled:text-porcelain',
    'btn-danger':
      'btn-base bg-transparent text-red border-[color-mix(in_srgb,var(--c-red)_35%,transparent)] hover:not-disabled:bg-[color-mix(in_srgb,var(--c-red)_8%,transparent)] hover:not-disabled:border-[color-mix(in_srgb,var(--c-red)_55%,transparent)]',
    card: 'rounded-[var(--radius-sm)] bg-graphite border border-[color-mix(in_srgb,var(--c-charcoal)_55%,transparent)]',
    'card-elevated':
      'rounded-[var(--radius-sm)] bg-slate border border-[color-mix(in_srgb,var(--c-ash)_45%,transparent)]',
    'card-nested':
      'rounded-[var(--radius-sm)] bg-pitch p-2 border border-[color-mix(in_srgb,var(--c-charcoal)_60%,transparent)]',
    'input-base':
      'w-full px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-charcoal bg-pitch text-porcelain text-[13px] outline-none transition-colors duration-150 placeholder:text-fog focus:border-ash focus:ring-1 focus:ring-[color-mix(in_srgb,var(--c-gunmetal)_45%,transparent)]',
    'section-title': 'text-[15px] font-[590] text-porcelain tracking-[-0.2px]',
    'section-desc': 'text-[12px] text-fog mt-0.5',
    label: 'text-[10px] font-medium uppercase tracking-[0.08em] text-fog',
    badge:
      'inline-flex items-center gap-1 px-1.5 py-px rounded-[var(--radius-sm)] text-[11px] font-medium bg-gunmetal/40 text-storm',
    tag: 'inline-flex items-center px-1.5 py-px rounded-[var(--radius-sm)] text-[11px] font-mono bg-charcoal/70 text-storm',
    'stat-card':
      'rounded-[var(--radius-sm)] bg-graphite px-3 py-2.5 border border-[color-mix(in_srgb,var(--c-charcoal)_50%,transparent)]',
    'stat-card-lg':
      'rounded-[var(--radius-sm)] bg-graphite px-3 py-3 border border-[color-mix(in_srgb,var(--c-charcoal)_60%,transparent)] flex flex-col gap-1',
    divider: 'border-t border-[color-mix(in_srgb,var(--c-charcoal)_60%,transparent)]',
    sec: 'pt-5 mt-5 border-t border-[color-mix(in_srgb,var(--c-charcoal)_55%,transparent)]',
    'sec-desc': 'text-[12px] text-fog mt-1',
    'kv-label': 'text-fog',
    'kv-value': 'text-storm font-mono truncate',
    'rail-btn':
      'flex items-center justify-center w-10 h-8 rounded-[var(--radius-sm)] text-storm transition-colors duration-100 hover:bg-charcoal/50 hover:text-porcelain outline-none focus-visible:ring-1 focus-visible:ring-accent/60',
    'sidebar-item':
      'flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-sm)] text-[12px] text-storm transition-colors duration-100 hover:bg-charcoal/40 hover:text-porcelain',
    'sidebar-item-active':
      'flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-sm)] text-[12px] text-porcelain bg-charcoal/60',
    'log-row':
      'flex items-center gap-3 px-3 py-1.5 text-[13px] font-mono border-b border-[color-mix(in_srgb,var(--c-charcoal)_50%,transparent)] hover:bg-[color-mix(in_srgb,var(--c-slate)_50%,transparent)] transition-colors duration-75',
    'modal-overlay': 'fixed inset-0 bg-pitch/75 animate-fade-in',
    'modal-content':
      'fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 max-h-[85vh] overflow-y-auto bg-graphite border border-[color-mix(in_srgb,var(--c-ash)_50%,transparent)] rounded-[var(--radius-lg)] shadow-[var(--shadow-xl)] p-5 animate-fade-in',
    'tab-list':
      'flex gap-0 bg-pitch border border-[color-mix(in_srgb,var(--c-charcoal)_60%,transparent)] rounded-[var(--radius-sm)] p-0.5',
    'tab-trigger':
      'flex-1 px-3 py-1 rounded-[var(--radius-sm)] text-[12px] font-medium text-fog transition-colors data-[state=active]:bg-charcoal data-[state=active]:text-porcelain hover:text-storm outline-none focus-visible:ring-1 focus-visible:ring-accent/60 focus-visible:ring-offset-1 focus-visible:ring-offset-pitch'
  }
})
