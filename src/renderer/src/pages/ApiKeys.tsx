import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { usePolling } from '../hooks/usePolling'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { ConfirmDialog } from '../components/ui/ConfirmDialog'
import { useToast } from '../components/ui/ToastContext'

type ApiKeyEntry = {
  id: string
  key: string
  name: string
  createdAt: number
  lastUsedAt?: number
  expiresAt?: number
  scopes?: string[]
}

type GatewayStatus = {
  server: { running: boolean; url: string; host: string; port: number; apiKeys: ApiKeyEntry[] }
  providers: Array<{ name: string; providerType: string; enabled: boolean }>
}

const EXPIRY_OPTIONS = [
  { value: 0, labelKey: 'apiKeys.expiryNever' },
  { value: 7, labelKey: 'apiKeys.expiry7d' },
  { value: 30, labelKey: 'apiKeys.expiry30d' },
  { value: 90, labelKey: 'apiKeys.expiry90d' }
]

export default function ApiKeys(): React.JSX.Element {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { data: status, refresh } = usePolling<GatewayStatus>(
    () => window.api.gateway.status(),
    5000
  )
  const [busy, setBusy] = useState(false)
  const [showKey, setShowKey] = useState<string | null>(null)
  const [copied, setCopied] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyEntry | null>(null)

  // eslint-disable-next-line react-hooks/purity, react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [status])

  const providers = useMemo(
    () => (status?.providers ?? []).filter((p) => p.enabled).map((p) => p.providerType),
    [status?.providers]
  )

  async function run(action: () => Promise<any>, success: string): Promise<void> {
    setBusy(true)
    try {
      await action()
      await refresh()
      toast(success, 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  function copy(text: string, label: string): void {
    navigator.clipboard.writeText(text)
    setCopied(label)
    setTimeout(() => setCopied(''), 2000)
  }

  function relativeTime(ts?: number): string {
    if (!ts) return t('apiKeys.neverUsed')
    const diff = now - ts
    if (diff < 60_000) return t('gateway.justNow')
    if (diff < 3600_000) return t('gateway.mAgo', { count: Math.floor(diff / 60_000) })
    if (diff < 86400_000) return t('gateway.hAgo', { count: Math.floor(diff / 3600_000) })
    return t('gateway.dAgo', { count: Math.floor(diff / 86400_000) })
  }

  function expiryLabel(entry: ApiKeyEntry): string {
    if (!entry.expiresAt) return t('apiKeys.never')
    if (now > entry.expiresAt) return t('apiKeys.expired')
    const days = Math.ceil((entry.expiresAt - now) / 86400_000)
    return `${days}d`
  }

  const keys = status?.server.apiKeys ?? []

  return (
    <div className="space-y-5">
      <div>
        <h1 className="section-title">{t('apiKeys.title')}</h1>
        <p className="section-desc">{t('apiKeys.desc')}</p>
      </div>

      <div className="card">
        <div className="flex items-center justify-between px-4 py-3 border-b border-charcoal">
          <h2 className="text-[13px] font-medium text-porcelain">
            {t('apiKeys.count', { count: keys.length })}
          </h2>
          <Button variant="primary" disabled={busy} onClick={() => setCreateOpen(true)}>
            {t('apiKeys.generate')}
          </Button>
        </div>
        <div className="px-4 py-3 space-y-3">
          {keys.map((entry) => (
            <div
              key={entry.id}
              className="py-3 px-4 rounded-[var(--radius-md)] bg-pitch border border-charcoal/60 hover:border-charcoal transition-all duration-200 space-y-2"
            >
              <div className="flex items-center justify-between">
                <span className="text-[13px] text-porcelain font-[590]">{entry.name}</span>
                <div className="flex items-center gap-2">
                  {entry.expiresAt && now > entry.expiresAt && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-red/10 border border-red/20 text-red">
                      {t('apiKeys.expired')}
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="!px-2 !py-0.5 text-red/80 hover:text-red transition-colors"
                    disabled={busy}
                    onClick={() => setRevokeTarget(entry)}
                  >
                    {t('apiKeys.revoke')}
                  </Button>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span
                  className="text-[12px] text-storm font-mono break-all flex-1 tracking-wider"
                  onClick={() => setShowKey(showKey === entry.id ? null : entry.id)}
                >
                  {showKey === entry.id ? entry.key : `${entry.key.slice(0, 12)} ···· ···· ····`}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="!px-2 !py-0.5 font-medium"
                  onClick={() => copy(entry.key, entry.id)}
                >
                  {copied === entry.id ? t('common.copied') : t('common.copy')}
                </Button>
              </div>

              <div className="flex items-center gap-4 text-[11px] text-fog font-medium">
                <span>
                  {t('apiKeys.createdAt')}: {new Date(entry.createdAt).toLocaleDateString()}
                </span>
                <span>
                  {t('apiKeys.lastUsed')}: {relativeTime(entry.lastUsedAt)}
                </span>
                <span>
                  {t('apiKeys.expiresAt')}: {expiryLabel(entry)}
                </span>
                <span>
                  {t('apiKeys.scope')}:{' '}
                  {entry.scopes?.length ? (
                    <span className="text-storm">{entry.scopes.join(', ')}</span>
                  ) : (
                    <span className="text-storm">{t('apiKeys.scopeAll')}</span>
                  )}
                </span>
              </div>
            </div>
          ))}
          {keys.length === 0 && (
            <p className="text-[12px] text-fog text-center py-4">{t('apiKeys.empty')}</p>
          )}
        </div>
      </div>

      <CreateKeyModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        providers={providers}
        busy={busy}
        onSubmit={async (options) => {
          await run(() => window.api.gateway.generateApiKey(options), t('apiKeys.generated'))
          setCreateOpen(false)
        }}
      />

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
        title={t('apiKeys.revoke')}
        description={t('apiKeys.revokeConfirm', { name: revokeTarget?.name ?? '' })}
        confirmLabel={t('apiKeys.revoke')}
        cancelLabel={t('common.cancel')}
        variant="danger"
        loading={busy}
        onConfirm={async () => {
          if (!revokeTarget) return
          await run(() => window.api.gateway.revokeApiKey(revokeTarget.id), t('apiKeys.revoked'))
          setRevokeTarget(null)
        }}
      />
    </div>
  )
}

function CreateKeyModal({
  open,
  onOpenChange,
  providers,
  busy,
  onSubmit
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  providers: string[]
  busy: boolean
  onSubmit: (options: { name: string; expiresAt?: number; scopes?: string[] }) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [expiryDays, setExpiryDays] = useState(0)
  const [scopeAll, setScopeAll] = useState(true)
  const [selectedScopes, setSelectedScopes] = useState<string[]>([])

  function reset(): void {
    setName('')
    setExpiryDays(0)
    setScopeAll(true)
    setSelectedScopes([])
  }

  function handleSubmit(): void {
    if (!name.trim()) return
    const expiresAt = expiryDays > 0 ? Date.now() + expiryDays * 86400_000 : undefined
    const scopes = scopeAll ? undefined : selectedScopes
    onSubmit({ name: name.trim(), expiresAt, scopes }).then(reset)
  }

  function toggleScope(provider: string): void {
    setSelectedScopes((prev) =>
      prev.includes(provider) ? prev.filter((p) => p !== provider) : [...prev, provider]
    )
  }

  return (
    <Modal
      open={open}
      onOpenChange={(v) => {
        if (!v) reset()
        onOpenChange(v)
      }}
      title={t('apiKeys.generateTitle')}
    >
      <div className="space-y-4">
        <div>
          <label id="apikey-name-label" className="text-[12px] text-fog font-medium block mb-1">
            {t('apiKeys.name')}
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('apiKeys.namePlaceholder')}
            className="input-base w-full"
            autoFocus
            autoComplete="off"
            aria-labelledby="apikey-name-label"
          />
        </div>

        <div>
          <label id="apikey-expiry-label" className="text-[12px] text-fog font-medium block mb-1">
            {t('apiKeys.expiry')}
          </label>
          <div
            role="radiogroup"
            aria-labelledby="apikey-expiry-label"
            className="flex gap-2 flex-wrap"
          >
            {EXPIRY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={expiryDays === opt.value}
                className={`px-3 py-1 text-[12px] rounded-[var(--radius-sm)] border transition-all ${
                  expiryDays === opt.value
                    ? 'border-gunmetal bg-charcoal text-porcelain font-medium'
                    : 'border-charcoal text-fog hover:text-storm hover:border-gunmetal'
                }`}
                onClick={() => setExpiryDays(opt.value)}
              >
                {t(opt.labelKey)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-[12px] text-fog font-medium block mb-1.5">
            {t('apiKeys.scopeLabel')}
          </label>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-[12px] text-storm select-none">
              <input
                type="checkbox"
                checked={scopeAll}
                onChange={(e) => setScopeAll(e.target.checked)}
                className="custom-checkbox"
              />
              <span>{t('apiKeys.scopeAllOption')}</span>
            </label>
            {!scopeAll && (
              <div className="flex gap-3 flex-wrap pl-6">
                {providers.map((p) => (
                  <label
                    key={p}
                    className="flex items-center gap-1.5 text-[12px] text-storm select-none"
                  >
                    <input
                      type="checkbox"
                      checked={selectedScopes.includes(p)}
                      onChange={() => toggleScope(p)}
                      className="custom-checkbox"
                    />
                    <span>{p}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={handleSubmit}>
            {t('apiKeys.generate')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
