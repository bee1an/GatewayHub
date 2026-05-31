import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../components/ui/Button'
import { ConfirmDialog } from '../components/ui/ConfirmDialog'
import { Modal } from '../components/ui/Modal'
import { Select, type SelectOption } from '../components/ui/Select'
import { useToast } from '../components/ui/ToastContext'
import { ProviderLogo } from '../components/ProviderLogo'
import { getProviderLogoLabel } from '../components/providerLogoData'
import { useTheme } from '../components/useTheme'

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
  displayName?: string
  enabled: boolean
  configured: boolean
  status: string
  models: string[]
}

type EditingCell = { row: number; field: 'alias' | 'provider' | 'model' | 'note' }

type DialogState = { mode: 'add' } | { mode: 'edit'; idx: number } | null

export default function ModelMappings(): React.JSX.Element {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [mappings, setMappings] = useState<ModelMapping[]>([])
  const [providers, setProviders] = useState<ProviderStatus[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dialogState, setDialogState] = useState<DialogState>(null)
  const [editing, setEditing] = useState<EditingCell | null>(null)
  const [draft, setDraft] = useState('')
  const [removeTarget, setRemoveTarget] = useState<number | null>(null)

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

  async function persist(next: ModelMapping[]): Promise<void> {
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

  function startEdit(row: number, field: EditingCell['field']): void {
    if (busy) return
    const m = mappings[row]
    const value = field === 'note' ? (m.note ?? '') : m[field]
    setEditing({ row, field })
    setDraft(value)
  }

  function commitEdit(): void {
    if (!editing) return
    const { row, field } = editing
    const trimmed = draft.trim()
    const m = mappings[row]

    if (field === 'alias') {
      if (!trimmed || /[\s/:]/.test(trimmed)) {
        cancelEdit()
        return
      }
      if (trimmed !== m.alias && mappings.some((x, i) => i !== row && x.alias === trimmed)) {
        toast(t('modelMappings.aliasDup'), 'error')
        cancelEdit()
        return
      }
    }

    const currentValue = field === 'note' ? (m.note ?? '') : m[field]
    if (trimmed === currentValue.trim()) {
      setEditing(null)
      return
    }

    const updated = { ...m, [field]: field === 'note' ? trimmed || undefined : trimmed }
    const next = mappings.map((x, i) => (i === row ? updated : x))
    setEditing(null)
    persist(next)
  }

  function commitSelectEdit(value: string): void {
    if (!editing) return
    const { row, field } = editing
    const m = mappings[row]
    const updated = { ...m, [field]: value }
    if (field === 'provider' && value !== m.provider) {
      updated.model = ''
    }
    const next = mappings.map((x, i) => (i === row ? updated : x))
    setEditing(null)
    persist(next)
  }

  function cancelEdit(): void {
    setEditing(null)
  }

  async function handleToggle(idx: number): Promise<void> {
    const next = mappings.map((m, i) => (i === idx ? { ...m, enabled: !m.enabled } : m))
    persist(next)
  }

  async function handleRemove(idx: number): Promise<void> {
    const next = mappings.filter((_, i) => i !== idx)
    setRemoveTarget(null)
    persist(next)
  }

  async function handleAdd(mapping: ModelMapping): Promise<void> {
    const next = [...mappings, mapping]
    setDialogState(null)
    persist(next)
    toast(t('modelMappings.saved'), 'success')
  }

  async function handleEdit(idx: number, mapping: ModelMapping): Promise<void> {
    const next = mappings.map((m, i) => (i === idx ? mapping : m))
    setDialogState(null)
    persist(next)
    toast(t('modelMappings.saved'), 'success')
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
          <Button
            size="sm"
            variant="primary"
            onClick={() => setDialogState({ mode: 'add' })}
            disabled={!loaded || busy}
          >
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
              <MappingRow
                key={`${m.alias}-${idx}`}
                mapping={m}
                idx={idx}
                editing={editing}
                draft={draft}
                setDraft={setDraft}
                providers={providers}
                providerOptions={providerOptions}
                busy={busy}
                onStartEdit={startEdit}
                onCommit={commitEdit}
                onCommitSelect={commitSelectEdit}
                onCancel={cancelEdit}
                onToggle={handleToggle}
                onRemove={(i) => setRemoveTarget(i)}
                onEdit={(i) => setDialogState({ mode: 'edit', idx: i })}
              />
            ))}
          </div>
        )}
      </div>

      <MappingDialog
        state={dialogState}
        onClose={() => setDialogState(null)}
        providerOptions={providerOptions}
        providers={providers}
        mappings={mappings}
        onAdd={handleAdd}
        onEdit={handleEdit}
      />

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(o) => {
          if (!o) setRemoveTarget(null)
        }}
        title={t('modelMappings.removeConfirmTitle')}
        description={t('modelMappings.removeConfirmDesc', {
          alias: removeTarget !== null ? mappings[removeTarget]?.alias : ''
        })}
        confirmLabel={t('modelMappings.remove')}
        onConfirm={() => {
          if (removeTarget !== null) handleRemove(removeTarget)
        }}
        variant="danger"
      />
    </div>
  )
}

function MappingRow({
  mapping: m,
  idx,
  editing,
  draft,
  setDraft,
  providers,
  providerOptions,
  busy,
  onStartEdit,
  onCommit,
  onCommitSelect,
  onCancel,
  onToggle,
  onRemove,
  onEdit
}: {
  mapping: ModelMapping
  idx: number
  editing: EditingCell | null
  draft: string
  setDraft: (v: string) => void
  providers: ProviderStatus[]
  providerOptions: string[]
  busy: boolean
  onStartEdit: (row: number, field: EditingCell['field']) => void
  onCommit: () => void
  onCommitSelect: (value: string) => void
  onCancel: () => void
  onToggle: (idx: number) => void
  onRemove: (idx: number) => void
  onEdit: (idx: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const isEditing = (field: EditingCell['field']) =>
    editing?.row === idx && editing?.field === field

  const selectedProvider = useMemo(
    () => providers.find((pr) => pr.name === m.provider),
    [providers, m.provider]
  )

  const availableModels = useMemo(() => {
    return selectedProvider?.models ?? []
  }, [selectedProvider?.models])

  const providerSelectOptions: SelectOption[] = useMemo(
    () => providerOptions.map((p) => ({ value: p, label: p })),
    [providerOptions]
  )

  const modelSelectOptions: SelectOption[] = useMemo(
    () => availableModels.map((model) => ({ value: model, label: model })),
    [availableModels]
  )

  return (
    <div
      className={`grid grid-cols-[minmax(100px,1.2fr)_minmax(80px,0.8fr)_minmax(120px,1.4fr)_minmax(80px,0.8fr)_44px_88px] gap-x-3 px-4 py-1.5 items-center text-[12px] hover:bg-charcoal/20 transition-colors ${idx > 0 ? 'border-t border-charcoal/20' : ''}`}
    >
      {/* alias */}
      {isEditing('alias') ? (
        <InlineInput
          value={draft}
          onChange={setDraft}
          onCommit={onCommit}
          onCancel={onCancel}
          mono
        />
      ) : (
        <span
          className="font-mono text-porcelain truncate cursor-text rounded px-1 -mx-1 hover:bg-charcoal/40"
          onClick={() => onStartEdit(idx, 'alias')}
        >
          {m.alias}
        </span>
      )}

      {/* provider */}
      {isEditing('provider') ? (
        <Select
          value={draft}
          onValueChange={(v) => onCommitSelect(v)}
          options={providerSelectOptions}
          placeholder="—"
          size="sm"
          open
          onOpenChange={(o) => {
            if (!o) onCancel()
          }}
        />
      ) : (
        <span
          className="text-steel truncate cursor-pointer rounded px-1 -mx-1 hover:bg-charcoal/40 inline-flex items-center gap-1.5"
          onClick={() => onStartEdit(idx, 'provider')}
        >
          <ProviderLogo
            providerType={selectedProvider?.providerType ?? m.provider}
            label={getProviderLogoLabel(
              selectedProvider?.providerType ?? m.provider,
              selectedProvider?.displayName
            )}
            theme={theme}
            size="xs"
          />
          <span className="truncate">{m.provider}</span>
        </span>
      )}

      {/* model */}
      {isEditing('model') ? (
        modelSelectOptions.length > 0 ? (
          <Select
            value={draft}
            onValueChange={(v) => onCommitSelect(v)}
            options={modelSelectOptions}
            placeholder="—"
            size="sm"
            mono
            open
            onOpenChange={(o) => {
              if (!o) onCancel()
            }}
          />
        ) : (
          <InlineInput
            value={draft}
            onChange={setDraft}
            onCommit={onCommit}
            onCancel={onCancel}
            mono
          />
        )
      ) : (
        <span
          className="font-mono text-steel truncate cursor-text rounded px-1 -mx-1 hover:bg-charcoal/40"
          onClick={() => onStartEdit(idx, 'model')}
        >
          {m.model || '—'}
        </span>
      )}

      {/* note */}
      {isEditing('note') ? (
        <InlineInput value={draft} onChange={setDraft} onCommit={onCommit} onCancel={onCancel} />
      ) : (
        <span
          className="text-fog truncate cursor-text rounded px-1 -mx-1 hover:bg-charcoal/40"
          onClick={() => onStartEdit(idx, 'note')}
        >
          {m.note || '—'}
        </span>
      )}

      {/* enabled */}
      <div className="flex justify-center">
        <input
          type="checkbox"
          checked={m.enabled}
          onChange={() => onToggle(idx)}
          className="custom-checkbox"
          disabled={busy}
        />
      </div>

      {/* actions */}
      <div className="flex items-center justify-end gap-1">
        <button
          type="button"
          onClick={() => onEdit(idx)}
          className="text-[11px] text-storm hover:text-porcelain transition-colors outline-none px-1.5 py-0.5 rounded-[var(--radius-sm)] hover:bg-charcoal/40 disabled:opacity-40"
          disabled={busy}
        >
          {t('modelMappings.edit')}
        </button>
        <button
          type="button"
          onClick={() => onRemove(idx)}
          className="text-[11px] text-storm hover:text-red transition-colors outline-none px-1.5 py-0.5 rounded-[var(--radius-sm)] hover:bg-charcoal/40 disabled:opacity-40"
          disabled={busy}
        >
          {t('modelMappings.remove')}
        </button>
      </div>
    </div>
  )
}

function InlineInput({
  value,
  onChange,
  onCommit,
  onCancel,
  mono
}: {
  value: string
  onChange: (v: string) => void
  onCommit: () => void
  onCancel: () => void
  mono?: boolean
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onCommit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
      className={`input-base w-full !py-0.5 !text-[12px] ${mono ? 'font-mono' : ''}`}
    />
  )
}

function MappingDialog({
  state,
  onClose,
  providerOptions,
  providers,
  mappings,
  onAdd,
  onEdit
}: {
  state: DialogState
  onClose: () => void
  providerOptions: string[]
  providers: ProviderStatus[]
  mappings: ModelMapping[]
  onAdd: (mapping: ModelMapping) => void
  onEdit: (idx: number, mapping: ModelMapping) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [alias, setAlias] = useState('')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [note, setNote] = useState('')

  const isEdit = state?.mode === 'edit'
  const editingIdx = state?.mode === 'edit' ? state.idx : -1
  const open = state !== null

  useEffect(() => {
    if (!open) return
    /* eslint-disable react-hooks/set-state-in-effect */
    if (state?.mode === 'edit') {
      const target = mappings[state.idx]
      if (target) {
        setAlias(target.alias)
        setProvider(target.provider)
        setModel(target.model)
        setNote(target.note ?? '')
      }
    } else {
      setAlias('')
      setProvider(providerOptions[0] ?? '')
      setModel('')
      setNote('')
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, state, mappings, providerOptions])

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
    if (/[\s/:]/.test(trimmed)) return 'aliasInvalid'
    const dup = mappings.some((m, i) => i !== editingIdx && m.alias.trim() === trimmed)
    if (dup) return 'aliasDup'
    return null
  })()

  const canSubmit = !aliasError && provider && model.trim()

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault()
    if (!canSubmit) return
    const mapping: ModelMapping = {
      alias: alias.trim(),
      provider,
      model: model.trim(),
      enabled: isEdit ? (mappings[editingIdx]?.enabled ?? true) : true,
      note: note.trim() || undefined
    }
    if (isEdit) onEdit(editingIdx, mapping)
    else onAdd(mapping)
  }

  const title = isEdit ? t('modelMappings.editRow') : t('modelMappings.addRow')

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
      title={title}
      width="420px"
    >
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
          <Button type="button" size="sm" onClick={onClose}>
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
