import { useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useTranslation } from 'react-i18next'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { TabGroup } from '../components/ui/TabGroup'

const apiKeyFormSchema = z.object({ apiKey: z.string().trim().min(1) })
type ApiKeyForm = z.infer<typeof apiKeyFormSchema>

export function AddOpenRouterAccountDialog({
  open,
  onOpenChange,
  onImported
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onImported: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState('key')
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { isSubmitting: keyLoading }
  } = useForm<ApiKeyForm>({
    resolver: zodResolver(apiKeyFormSchema),
    defaultValues: { apiKey: '' }
  })
  const keyText = useWatch({ control, name: 'apiKey' })
  const [jsonText, setJsonText] = useState('')
  const [jsonLoading, setJsonLoading] = useState(false)
  const [jsonResult, setJsonResult] = useState<{
    added: number
    skipped: number
    errors: string[]
  } | null>(null)

  const handleKey = handleSubmit(async ({ apiKey }) => {
    setKeyMsg(null)
    try {
      await window.api.gateway.addOpenRouterApiKey(apiKey)
      setKeyMsg({ ok: true, text: t('addAccount.tokenValid') })
      reset()
      onImported()
      onOpenChange(false)
    } catch (err: any) {
      setKeyMsg({ ok: false, text: err?.message || t('addAccount.tokenInvalid') })
    }
  })

  async function handleJson(): Promise<void> {
    if (!jsonText.trim()) return
    setJsonLoading(true)
    setJsonResult(null)
    try {
      const r = await window.api.gateway.importOpenRouterJson(jsonText)
      setJsonResult({ added: r.added, skipped: r.skipped, errors: r.errors })
      if (r.added > 0) {
        setJsonText('')
        onImported()
      }
    } catch (err: any) {
      setJsonResult({ added: 0, skipped: 0, errors: [err?.message || 'Unknown error'] })
    } finally {
      setJsonLoading(false)
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('addAccount.openrouterTitle')}>
      <TabGroup
        value={tab}
        onValueChange={setTab}
        items={[
          {
            value: 'key',
            label: t('addAccount.tabs.apiKey'),
            content: (
              <div className="space-y-3">
                <p className="text-[12px] text-fog">{t('addAccount.openrouterKeyHint')}</p>
                <textarea
                  {...register('apiKey')}
                  placeholder={t('addAccount.openrouterKeyPlaceholder')}
                  className="input-base font-mono text-[12px] min-h-20 resize-y w-full"
                />
                <div className="flex items-center gap-3">
                  <Button
                    variant="primary"
                    onClick={() => void handleKey()}
                    disabled={keyLoading || !keyText.trim()}
                  >
                    {keyLoading ? t('addAccount.tokenValidating') : t('common.add')}
                  </Button>
                  {keyMsg && (
                    <p className={`text-[12px] ${keyMsg.ok ? 'text-emerald' : 'text-red'}`}>
                      {keyMsg.text}
                    </p>
                  )}
                </div>
              </div>
            )
          },
          {
            value: 'json',
            label: t('addAccount.tabs.json'),
            content: (
              <div className="space-y-2">
                <p className="text-[12px] text-fog">{t('addAccount.openrouterJsonHint')}</p>
                <textarea
                  className="w-full min-h-[120px] text-[12px] font-mono bg-[var(--glass-bg-thin)] rounded-[var(--radius-md)] p-2 text-storm"
                  value={jsonText}
                  onChange={(e) => setJsonText(e.target.value)}
                  placeholder={t('addAccount.openrouterJsonPlaceholder')}
                />
                <div className="flex items-center gap-2">
                  <Button
                    variant="primary"
                    onClick={handleJson}
                    disabled={jsonLoading || !jsonText.trim()}
                  >
                    {jsonLoading ? t('addAccount.jsonImporting') : t('common.add')}
                  </Button>
                  {jsonResult && (
                    <span className="text-[12px] text-fog">
                      {t('addAccount.jsonResult', {
                        added: jsonResult.added,
                        skipped: jsonResult.skipped
                      })}
                      {jsonResult.errors.length > 0 && (
                        <span className="text-red ml-2">
                          {t('addAccount.jsonErrors', { count: jsonResult.errors.length })}
                        </span>
                      )}
                    </span>
                  )}
                </div>
                {jsonResult && jsonResult.errors.length > 0 && (
                  <div className="text-[12px] text-red space-y-0.5 max-h-40 overflow-y-auto">
                    {jsonResult.errors.map((e, i) => (
                      <p key={i} className="opacity-80 break-all whitespace-pre-wrap">
                        {e}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )
          }
        ]}
      />
    </Modal>
  )
}
