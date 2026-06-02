import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'

export function AddGrokWebAccountDialog({
  open,
  onOpenChange,
  onImported
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onImported: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [jsonText, setJsonText] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{
    added: number
    skipped: number
    errors: string[]
  } | null>(null)

  async function handleImport(): Promise<void> {
    if (!jsonText.trim()) return
    setLoading(true)
    setResult(null)
    try {
      const r = await window.api.gateway.importGrokWebJson(jsonText)
      setResult({
        added: r.added,
        skipped: r.skipped,
        errors: (r.errors || []).map((e: any) => (typeof e === 'string' ? e : e.message))
      })
      if (r.added > 0 || r.skipped > 0) {
        setJsonText('')
        onImported()
        onOpenChange(false)
      }
    } catch (err: any) {
      setResult({ added: 0, skipped: 0, errors: [err?.message || 'Unknown error'] })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('addAccount.grokWebTitle')}>
      <div className="space-y-3">
        <p className="text-[12px] text-fog">{t('addAccount.grokWebJsonHint')}</p>
        <textarea
          className="w-full min-h-[160px] text-[12px] font-mono bg-pitch rounded-[var(--radius-md)] p-2 text-storm"
          value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
          placeholder={t('addAccount.grokWebJsonPlaceholder')}
        />
        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={handleImport} disabled={loading || !jsonText.trim()}>
            {loading ? t('addAccount.jsonImporting') : t('common.add')}
          </Button>
          {result && (
            <span className="text-[12px] text-fog">
              {t('addAccount.jsonResult', {
                added: result.added,
                skipped: result.skipped
              })}
              {result.errors.length > 0 && (
                <span className="text-red ml-2">
                  {t('addAccount.jsonErrors', { count: result.errors.length })}
                </span>
              )}
            </span>
          )}
        </div>
        {result && result.errors.length > 0 && (
          <div className="text-[12px] text-red space-y-0.5 max-h-40 overflow-y-auto">
            {result.errors.map((e, i) => (
              <p key={i} className="opacity-80 break-all whitespace-pre-wrap">
                {e}
              </p>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
