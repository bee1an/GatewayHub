import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { Select, type SelectOption } from '../components/ui/Select'
import { useToast } from '../components/ui/ToastContext'

type ModelMapping = {
  alias: string
  provider: string
  model: string
  enabled: boolean
  note?: string
}

type ProviderStatus = {
  name: string
  providerType: string
  enabled: boolean
  configured: boolean
  status: string
  models: string[]
}

export default function ModelMappings(): React.JSX.Element {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [mappings, setMappings] = useState<ModelMapping[]>([])
  const [providers, setProviders] = useState<ProviderStatus[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editIndex, setEditIndex] = useState<number | null>(null)

  useEffect(() => {
    Promise.all([window.api.gateway.getModelMappings(), window.api.gateway.status()])
      .then(([m, status]: [ModelMapping[], { providers: ProviderStatus[] }]) => {
        setMappings(Array.isArray(m) ? m : [])
        setProviders(Array.isArray(status?.providers) ? status.providers : [])
      })
      .finally(() => setLoaded(true))
  }, [])

  const providerOptions = useMemo(
    () => providers.filter((p) => p.enabled && p.configured).map((p) => p.name),
    [providers]
  )

  function openAdd(): void {
    setEditIndex(null)
    setDialogOpen(true)
  }

  function openEdit(idx: number): void {
    setEditIndex(idx)
    setDialogOpen(true)
  }

  async function handleSave(mapping: ModelMapping): Promise<void> {
    let next: ModelMapping[]
    if (editIndex !== null) {
      next = mappings.map((m, i) => (i === editIndex ? mapping : m))
    } else {
      next = [...mappings, mapping]
    }
    setMappings(next)
    setDialogOpen(false)
    setBusy(true)
    try {
      await window.api.gateway.updateModelMappings(next)
      toast(t('modelMappings.saved'), 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function handleToggle(idx: number): Promise<void> {
    const next = mappings.map((m, i) => (i === idx ? { ...m, enabled: !m.enabled } : m))
    setMappings(next)
    setBusy(true)
    try {
      await window.api.gateway.updateModelMappings(next)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function handleRemove(idx: number): Promise<void> {
    const next = mappings.filter((_, i) => i !== idx)
    setMappings(next)
    setBusy(true)
    try {
      await window.api.gateway.updateModelMappings(next)
      toast(t('modelMappings.saved'), 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5 animate-fade-in">
      <div>
        <h1 className="section-title">{t('modelMappings.title')}</h1>
        <p className="section-desc">{t('modelMappings.desc')}</p>
      </div>

      <div className="card">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-charcoal/60">
          <div>
            <h2 className="text-[13px] font-medium text-porcelain">
              {t('modelMappings.listTitle')}
            </h2>
            <p className="text-[11px] text-fog mt-0.5">{t('modelMappings.listDesc')}</p>
          </div>
          <Button size="sm" variant="primary" onClick={openAdd} disabled={!loaded || busy}>
            {t('modelMappings.addRow')}
          </Button>
        </div>

        {mappings.length === 0 ? (
          <div className="px-4 py-12 text-center text-[12px] text-fog select-none">
            <span className="i-ph-arrows-left-right text-[24px] text-charcoal block mx-auto mb-2" />
            {t('modelMappings.empty')}
          </div>
        ) : (
          <div className="overflow-hidden">
            <div className="grid grid-cols-[minmax(100px,1.2fr)_minmax(80px,0.8fr)_minmax(120px,1.4fr)_minmax(80px,0.8fr)_44px_88px] gap-x-3 px-4 py-2 text-[11px] text-fog font-medium uppercase tracking-wide border-b border-charcoal/30">
              <span>{t('modelMappings.aliasCol')}</span>
              <span>{t('modelMappings.providerCol')}</span>
              <span>{t('modelMappings.modelCol')}</span>
              <span>{t('modelMappings.noteCol')}</span>
              <span className="text-center">{t('modelMappings.enabledCol')}</span>
              <span />
            </div>
            {mappings.map((m, idx) => (
              <div
                key={`${m.alias}-${idx}`}
                className={`grid grid-cols-[minmax(100px,1.2fr)_minmax(80px,0.8fr)_minmax(120px,1.4fr)_minmax(80px,0.8fr)_44px_88px] gap-x-3 px-4 py-2 items-center text-[12px] hover:bg-charcoal/20 transition-colors ${idx > 0 ? 'border-t border-charcoal/20' : ''}`}
              >
                <span className="font-mono text-porcelain truncate">{m.alias}</span>
                <span className="text-steel truncate">{m.provider}</span>
                <span className="font-mono text-steel truncate">{m.model}</span>
                <span className="text-fog truncate">{m.note || '—'}</span>
                <div className="flex justify-center">
                  <input
                    type="checkbox"
                    checked={m.enabled}
                    onChange={() => handleToggle(idx)}
                    className="custom-checkbox"
                    disabled={busy}
                  />
                </div>
                <div className="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => openEdit(idx)}
                    className="text-[11px] text-storm hover:text-porcelain transition-colors outline-none px-1.5 py-0.5 rounded-[var(--radius-sm)] hover:bg-charcoal/40"
                  >
                    {t('modelMappings.edit')}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemove(idx)}
                    className="text-[11px] text-storm hover:text-red transition-colors outline-none px-1.5 py-0.5 rounded-[var(--radius-sm)] hover:bg-charcoal/40 disabled:opacity-40"
                    disabled={busy}
                  >
                    {t('modelMappings.remove')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <MappingDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        providerOptions={providerOptions}
        providers={providers}
        existingAliases={mappings.map((m, i) => (i === editIndex ? '' : m.alias.trim()))}
        initial={editIndex !== null ? mappings[editIndex] : undefined}
        onSave={handleSave}
      />
    </div>
  )
}

function MappingDialog({
  open,
  onOpenChange,
  providerOptions,
  providers,
  existingAliases,
  initial,
  onSave
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  providerOptions: string[]
  providers: ProviderStatus[]
  existingAliases: string[]
  initial?: ModelMapping
  onSave: (mapping: ModelMapping) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [alias, setAlias] = useState('')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    if (open) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setAlias(initial?.alias ?? '')
      setProvider(initial?.provider ?? providerOptions[0] ?? '')
      setModel(initial?.model ?? '')
      setNote(initial?.note ?? '')
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [open, initial, providerOptions])

  const providerSelectOptions: SelectOption[] = useMemo(
    () => providerOptions.map((p) => ({ value: p, label: p })),
    [providerOptions]
  )

  const availableModels = useMemo(() => {
    const p = providers.find((pr) => pr.name === provider)
    return p?.models ?? []
  }, [providers, provider])

  const modelSelectOptions: SelectOption[] = useMemo(
    () => availableModels.map((m) => ({ value: m, label: m })),
    [availableModels]
  )

  const aliasError = (() => {
    const trimmed = alias.trim()
    if (!trimmed) return 'aliasEmpty'
    if (/[\s/]/.test(trimmed) || trimmed.includes(':')) return 'aliasInvalid'
    if (existingAliases.includes(trimmed)) return 'aliasDup'
    return null
  })()

  const canSubmit = !aliasError && provider && model.trim()

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault()
    if (!canSubmit) return
    onSave({
      alias: alias.trim(),
      provider,
      model: model.trim(),
      enabled: initial?.enabled ?? true,
      note: note.trim() || undefined
    })
  }

  const title = initial ? t('modelMappings.editRow') : t('modelMappings.addRow')

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} width="420px">
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="text-[11px] text-fog font-medium block mb-1">
            {t('modelMappings.aliasCol')}
          </label>
          <input
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            placeholder={t('modelMappings.aliasPlaceholder')}
            autoFocus
            className={`input-base font-mono w-full !py-1.5 !text-[12px] ${alias.trim() && aliasError ? '!border-red/60' : ''}`}
          />
          {alias.trim() && aliasError === 'aliasInvalid' && (
            <p className="text-[10px] text-red mt-0.5">{t('modelMappings.aliasInvalid')}</p>
          )}
          {alias.trim() && aliasError === 'aliasDup' && (
            <p className="text-[10px] text-red mt-0.5">{t('modelMappings.aliasDup')}</p>
          )}
        </div>
        <div>
          <label className="text-[11px] text-fog font-medium block mb-1">
            {t('modelMappings.providerCol')}
          </label>
          <Select
            value={provider}
            onValueChange={(v) => {
              setProvider(v)
              setModel('')
            }}
            options={providerSelectOptions}
            placeholder="—"
            size="md"
          />
        </div>
        <div>
          <label className="text-[11px] text-fog font-medium block mb-1">
            {t('modelMappings.modelCol')}
          </label>
          {modelSelectOptions.length > 0 ? (
            <Select
              value={model}
              onValueChange={setModel}
              options={modelSelectOptions}
              placeholder="—"
              size="md"
              mono
            />
          ) : (
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={t('modelMappings.modelPlaceholder')}
              className="input-base font-mono w-full !py-1.5 !text-[12px]"
            />
          )}
        </div>
        <div>
          <label className="text-[11px] text-fog font-medium block mb-1">
            {t('modelMappings.noteCol')}
          </label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('modelMappings.notePlaceholder')}
            className="input-base w-full !py-1.5 !text-[12px]"
          />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" size="sm" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" size="sm" variant="primary" disabled={!canSubmit}>
            {t('modelMappings.save')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
