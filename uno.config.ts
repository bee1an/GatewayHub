import { defineConfig, presetWind3, presetIcons } from 'unocss'

export default defineConfig({
  presets: [presetWind3(), presetIcons({ scale: 1.2 })],
  rules: [
    [
      'glass',
      {
        background: 'var(--glass-bg)',
        'backdrop-filter': 'var(--glass-filter)',
        '-webkit-backdrop-filter': 'var(--glass-filter)',
        'box-shadow': 'var(--glass-shadow)'
      }
    ],
    [
      'glass-strong',
      {
        background: 'var(--glass-bg-strong)',
        'backdrop-filter': 'var(--glass-filter)',
        '-webkit-backdrop-filter': 'var(--glass-filter)',
        'box-shadow': 'var(--glass-shadow)'
      }
    ],
    [
      'glass-thin',
      {
        background: 'var(--glass-bg-thin)',
        'box-shadow': 'var(--glass-shadow-sm)'
      }
    ]
  ],
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
      'inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-md)] font-medium border outline-none select-none transition-all duration-150 ease-out active:not-disabled:brightness-90 active:not-disabled:scale-[0.98] focus-visible:ring-1 focus-visible:ring-accent/70 focus-visible:ring-offset-1 focus-visible:ring-offset-pitch disabled:opacity-50',
    btn: 'btn-base glass-thin border-[var(--glass-border)] text-steel hover:not-disabled:border-[var(--glass-border-strong)] hover:not-disabled:text-porcelain hover:not-disabled:bg-[var(--glass-bg)]',
    'btn-primary':
      'btn-base bg-accent text-accent-text border-transparent font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_4px_14px_rgba(0,0,0,0.25)] hover:not-disabled:brightness-110 active:not-disabled:brightness-95',
    'btn-ghost':
      'btn-base bg-transparent text-storm border-transparent hover:not-disabled:bg-[var(--glass-bg-thin)] hover:not-disabled:text-porcelain',
    'btn-danger':
      'btn-base bg-transparent text-red border-[color-mix(in_srgb,var(--c-red)_35%,transparent)] hover:not-disabled:bg-[color-mix(in_srgb,var(--c-red)_8%,transparent)] hover:not-disabled:border-[color-mix(in_srgb,var(--c-red)_55%,transparent)]',
    card: 'rounded-[var(--radius-md)] bg-[var(--glass-bg-thin)] border border-[var(--glass-border)] shadow-[var(--glass-shadow-sm)]',
    'card-elevated':
      'rounded-[var(--radius-md)] bg-[var(--glass-bg)] border border-[var(--glass-border-strong)] shadow-[var(--glass-shadow-sm)]',
    'card-nested':
      'rounded-[var(--radius-sm)] p-2 bg-[var(--glass-bg-thin)] border border-[var(--glass-border)]',
    'input-base':
      'w-full px-2.5 py-1.5 rounded-[var(--radius-md)] border border-[var(--glass-border)] bg-[var(--glass-bg-thin)] text-porcelain text-[13px] outline-none transition-all duration-150 placeholder:text-fog focus:border-[var(--glass-border-strong)] focus:bg-[var(--glass-bg)] focus:ring-1 focus:ring-accent/40',
    'section-title': 'text-[15px] font-[590] text-porcelain tracking-[-0.2px]',
    'section-desc': 'text-[12px] text-fog mt-0.5',
    label: 'text-[10px] font-medium uppercase tracking-[0.08em] text-fog',
    badge:
      'inline-flex items-center gap-1 px-1.5 py-px rounded-[var(--radius-sm)] text-[11px] font-medium bg-[var(--glass-bg-thin)] border border-[var(--glass-border)] text-storm',
    tag: 'inline-flex items-center px-1.5 py-px rounded-[var(--radius-sm)] text-[11px] font-mono bg-[var(--glass-bg-thin)] border border-[var(--glass-border)] text-storm',
    'stat-card':
      'rounded-[var(--radius-md)] px-3 py-2.5 bg-[var(--glass-bg-thin)] border border-[var(--glass-border)] shadow-[var(--glass-shadow-sm)]',
    'stat-card-lg':
      'rounded-[var(--radius-md)] px-3 py-3 bg-[var(--glass-bg-thin)] border border-[var(--glass-border)] shadow-[var(--glass-shadow-sm)] flex flex-col gap-1',
    divider: 'border-t border-[var(--glass-border)]',
    sec: 'pt-5 mt-5 border-t border-[var(--glass-border)]',
    'sec-desc': 'text-[12px] text-fog mt-1',
    'kv-label': 'text-fog',
    'kv-value': 'text-storm font-mono truncate',
    'rail-btn':
      'flex items-center justify-center w-10 h-8 rounded-[var(--radius-md)] text-storm transition-colors duration-100 hover:bg-[var(--glass-bg)] hover:text-porcelain outline-none focus-visible:ring-1 focus-visible:ring-accent/60',
    'sidebar-item':
      'flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-md)] text-[12px] text-storm transition-colors duration-100 hover:bg-[var(--glass-bg-thin)] hover:text-porcelain',
    'sidebar-item-active':
      'flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-md)] text-[12px] text-porcelain bg-[var(--list-active-bg)] border border-[var(--list-active-border)]',
    'log-row':
      'flex items-center gap-3 px-3 py-1.5 text-[13px] font-mono border-b border-[var(--glass-border)] hover:bg-[var(--glass-bg-thin)] transition-colors duration-75',
    'modal-overlay': 'fixed inset-0 bg-pitch/55 backdrop-blur-[6px] animate-fade-in',
    'modal-content':
      'fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 max-h-[85vh] overflow-y-auto glass-strong border border-[var(--glass-border-strong)] rounded-[var(--radius-lg)] p-5 animate-fade-in',
    'tab-list':
      'flex gap-0 bg-[var(--glass-bg-thin)] border border-[var(--glass-border)] rounded-[var(--radius-md)] p-0.5',
    'tab-trigger':
      'flex-1 px-3 py-1 rounded-[var(--radius-sm)] text-[12px] font-medium text-fog transition-colors data-[state=active]:bg-[var(--glass-bg-strong)] data-[state=active]:text-porcelain data-[state=active]:shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] hover:text-storm outline-none focus-visible:ring-1 focus-visible:ring-accent/60 focus-visible:ring-offset-1 focus-visible:ring-offset-pitch'
  }
})
