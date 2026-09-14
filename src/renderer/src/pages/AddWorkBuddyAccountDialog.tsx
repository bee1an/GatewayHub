import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { TabGroup } from '../components/ui/TabGroup'

export function AddWorkBuddyAccountDialog({
  open,
  onOpenChange,
  onImported
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onImported: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState('discover')
  const [tokenText, setTokenText] = useState('')
  const [tokenLoading, setTokenLoading] = useState(false)
  const [tokenMsg, setTokenMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [jsonResult, setJsonResult] = useState<{
    added: number
    skipped: number
    errors: string[]
  } | null>(null)
  const [discoverLoading, setDiscoverLoading] = useState(false)
  const [scanResult, setScanResult] = useState<{
    candidates: Array<{
      id: string
      nickname?: string
      label?: string
      uid?: string
      domain?: string
      existing?: boolean
      sourceType?: string
    }>
  } | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  async function handleToken() {
    if (!tokenText.trim()) return
    setTokenLoading(true)
    setTokenMsg(null)
    setJsonResult(null)
    try {
      const r = await window.api.gateway.importWorkBuddyJson(tokenText)
      setJsonResult({ added: r.added, skipped: r.skipped, errors: r.errors })
      if (r.added > 0 || r.skipped > 0) {
        setTokenText('')
        onImported()
      }
    } catch (err: any) {
      setTokenMsg({ ok: false, text: err?.message || t('addAccount.tokenInvalid') })
    } finally {
      setTokenLoading(false)
    }
  }

  async function handleScan() {
    setDiscoverLoading(true)
    setScanResult(null)
    setSelectedIds(new Set())
    try {
      const r = await window.api.gateway.scanWorkBuddyAccounts()
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
      await window.api.gateway.importScannedWorkBuddyAccounts([...selectedIds])
      setScanResult(null)
      setSelectedIds(new Set())
      onImported()
      onOpenChange(false)
    } finally {
      setDiscoverLoading(false)
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('addAccount.workBuddyTitle')}>
      <TabGroup
        value={tab}
        onValueChange={setTab}
        items={[
          {
            value: 'discover',
            label: t('addAccount.tabs.discover'),
            content: (
              <div className="space-y-2">
                <p className="text-[12px] text-fog">{t('addAccount.workBuddyDiscoverDesc')}</p>
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
                              {c.label || c.nickname || c.id}
                            </p>
                            <p className="text-[12px] text-fog font-mono truncate">
                              {c.domain || c.sourceType || c.id}
                            </p>
                          </div>
                          <span className="tag text-[12px] !px-1 !py-0 shrink-0">
                            {c.existing ? t('gateway.exists') : 'workbuddy'}
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
          },
          {
            value: 'token',
            label: t('addAccount.tabs.json'),
            content: (
              <div className="space-y-3">
                <p className="text-[12px] text-fog">{t('addAccount.workBuddyTokenHint')}</p>
                <textarea
                  value={tokenText}
                  onChange={(e) => setTokenText(e.target.value)}
                  placeholder={t('addAccount.workBuddyTokenPlaceholder')}
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
                  {jsonResult && !tokenMsg && (
                    <span className="text-[12px] text-fog">
                      {t('addAccount.jsonResult', {
                        added: jsonResult.added,
                        skipped: jsonResult.skipped
                      })}
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
