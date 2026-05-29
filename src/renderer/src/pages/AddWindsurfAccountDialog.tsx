import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { TabGroup } from '../components/ui/TabGroup'

export function AddWindsurfAccountDialog({
  open,
  onOpenChange,
  onImported
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onImported: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState('token')
  const [tokenText, setTokenText] = useState('')
  const [tokenLoading, setTokenLoading] = useState(false)
  const [tokenMsg, setTokenMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [jsonText, setJsonText] = useState('')
  const [jsonLoading, setJsonLoading] = useState(false)
  const [jsonResult, setJsonResult] = useState<{
    added: number
    skipped: number
    errors: string[]
  } | null>(null)
  const [discoverLoading, setDiscoverLoading] = useState(false)
  const [scanResult, setScanResult] = useState<{
    candidates: Array<{
      id: string
      email?: string
      label?: string
      existing?: boolean
      sourceType?: string
    }>
  } | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  async function handleToken() {
    if (!tokenText.trim()) return
    setTokenLoading(true)
    setTokenMsg(null)
    try {
      await window.api.gateway.addWindsurfApiKey(tokenText)
      setTokenMsg({ ok: true, text: t('addAccount.tokenValid') })
      setTokenText('')
      onImported()
      onOpenChange(false)
    } catch (err: any) {
      setTokenMsg({ ok: false, text: err?.message || t('addAccount.tokenInvalid') })
    } finally {
      setTokenLoading(false)
    }
  }

  async function handleJson() {
    if (!jsonText.trim()) return
    setJsonLoading(true)
    setJsonResult(null)
    try {
      const r = await window.api.gateway.importWindsurfJson(jsonText)
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

  async function handleScan() {
    setDiscoverLoading(true)
    setScanResult(null)
    setSelectedIds(new Set())
    try {
      const r = await window.api.gateway.scanWindsurfAccounts()
      setScanResult(r)
      setSelectedIds(new Set(r.candidates.filter((c: any) => !c.existing).map((c: any) => c.id)))
    } finally {
      setDiscoverLoading(false)
    }
  }

  async function handleImportSelected() {
    if (selectedIds.size === 0) return
    setDiscoverLoading(true)
    try {
      await window.api.gateway.importScannedWindsurfAccounts([...selectedIds])
      setScanResult(null)
      setSelectedIds(new Set())
      onImported()
      onOpenChange(false)
    } finally {
      setDiscoverLoading(false)
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('addAccount.windsurfTitle')}>
      <TabGroup
        value={tab}
        onValueChange={setTab}
        items={[
          {
            value: 'token',
            label: t('addAccount.tabs.token'),
            content: (
              <div className="space-y-3">
                <p className="text-[12px] text-fog">{t('addAccount.windsurfTokenHint')}</p>
                <textarea
                  value={tokenText}
                  onChange={(e) => setTokenText(e.target.value)}
                  placeholder={t('addAccount.windsurfTokenPlaceholder')}
                  className="input-base font-mono text-[12px] min-h-20 resize-y w-full"
                />
                <div className="flex items-center gap-3">
                  <Button
                    variant="primary"
                    onClick={handleToken}
                    disabled={tokenLoading || !tokenText.trim()}
                  >
                    {tokenLoading ? t('addAccount.tokenValidating') : t('common.add')}
                  </Button>
                  {tokenMsg && (
                    <p className={`text-[12px] ${tokenMsg.ok ? 'text-emerald' : 'text-red'}`}>
                      {tokenMsg.text}
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
                <p className="text-[12px] text-fog">{t('addAccount.windsurfJsonHint')}</p>
                <textarea
                  className="w-full min-h-[120px] text-[12px] font-mono bg-pitch rounded-[var(--radius-md)] p-2 text-storm"
                  value={jsonText}
                  onChange={(e) => setJsonText(e.target.value)}
                  placeholder={t('addAccount.windsurfJsonPlaceholder')}
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
          },
          {
            value: 'discover',
            label: t('addAccount.tabs.discover'),
            content: (
              <div className="space-y-2">
                <p className="text-[12px] text-fog">{t('addAccount.windsurfDiscoverDesc')}</p>
                {!scanResult && (
                  <Button variant="primary" onClick={handleScan} disabled={discoverLoading}>
                    {discoverLoading ? t('addAccount.discoverRunning') : t('gateway.discover')}
                  </Button>
                )}
                {scanResult && scanResult.candidates.length === 0 && (
                  <p className="text-[12px] text-fog">{t('addAccount.discoverEmpty')}</p>
                )}
                {scanResult && scanResult.candidates.length > 0 && (
                  <div className="space-y-2">
                    <div className="space-y-1 max-h-44 overflow-y-auto">
                      {scanResult.candidates.map((c) => (
                        <label
                          key={c.id}
                          className="flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-md)] bg-pitch hover:bg-charcoal cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={selectedIds.has(c.id)}
                            disabled={c.existing}
                            onChange={() => {
                              const next = new Set(selectedIds)
                              if (next.has(c.id)) next.delete(c.id)
                              else next.add(c.id)
                              setSelectedIds(next)
                            }}
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-[12px] text-porcelain truncate">
                              {c.label || c.email || c.id}
                            </p>
                            <p className="text-[12px] text-fog font-mono truncate">
                              {c.email || c.sourceType || c.id}
                            </p>
                          </div>
                          <span className="tag text-[12px] !px-1 !py-0 shrink-0">
                            {c.existing ? t('gateway.exists') : c.sourceType || 'windsurf'}
                          </span>
                        </label>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="primary"
                        onClick={handleImportSelected}
                        disabled={selectedIds.size === 0 || discoverLoading}
                      >
                        {t('common.add')} ({selectedIds.size})
                      </Button>
                      <Button
                        onClick={() => {
                          setScanResult(null)
                          setSelectedIds(new Set())
                        }}
                      >
                        {t('common.cancel')}
                      </Button>
                    </div>
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
