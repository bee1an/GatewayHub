import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { TabGroup } from '../components/ui/TabGroup'

export function AddCodexAccountDialog({
  open,
  onOpenChange,
  onImported
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onImported: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState('browser')

  // Browser/device login state
  const [loginState, setLoginState] = useState<
    'idle' | 'pending' | 'authorize' | 'success' | 'failed'
  >('idle')
  const [loginMessage, setLoginMessage] = useState('')
  const [authorizeUrl, setAuthorizeUrl] = useState('')
  const [userCode, setUserCode] = useState('')
  const [linkCopied, setLinkCopied] = useState(false)

  // JSON paste tab
  const [jsonText, setJsonText] = useState('')
  const [jsonLoading, setJsonLoading] = useState(false)
  const [jsonResult, setJsonResult] = useState<{
    added: number
    skipped: number
    errors: string[]
  } | null>(null)

  // Discover tab (~/.codex/auth.json)
  const [discoverLoading, setDiscoverLoading] = useState(false)
  const [scanResult, setScanResult] = useState<{
    candidates: Array<{
      id: string
      email?: string
      label?: string
      gptWebAccountId?: string
      existing?: boolean
      sourceType?: string
    }>
  } | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!open) return
    const unsub = window.api.gateway.onCodexLoginEvent((event) => {
      if (event.kind === 'authorize') {
        setLoginState('authorize')
        setLoginMessage(event.message || '')
        setAuthorizeUrl(event.authorizeUrl || '')
        setUserCode(event.userCode || '')
      } else if (event.kind === 'success') {
        setLoginState('success')
        setLoginMessage('')
        onImported()
        setTimeout(() => onOpenChange(false), 600)
      } else if (event.kind === 'cancelled') {
        setLoginState('idle')
        setLoginMessage('')
      } else if (event.kind === 'error') {
        setLoginState('failed')
        setLoginMessage(event.message || 'Login failed')
      }
    })
    return unsub
  }, [open, onImported, onOpenChange])

  function resetLoginState(): void {
    setLoginState('idle')
    setLoginMessage('')
    setAuthorizeUrl('')
    setUserCode('')
  }

  async function handleBrowserLogin() {
    setLoginState('pending')
    setLoginMessage('')
    setAuthorizeUrl('')
    setUserCode('')
    try {
      await window.api.gateway.loginCodexBrowser()
    } catch (err: any) {
      setLoginState('failed')
      setLoginMessage(err?.message || String(err))
    }
  }

  async function handleDeviceLogin() {
    setLoginState('pending')
    setLoginMessage('')
    setAuthorizeUrl('')
    setUserCode('')
    try {
      await window.api.gateway.loginCodexDevice()
    } catch (err: any) {
      setLoginState('failed')
      setLoginMessage(err?.message || String(err))
    }
  }

  async function handleCancelLogin() {
    await window.api.gateway.cancelCodexLogin()
    setLoginState('idle')
  }

  async function handleCopyAuthorizeUrl() {
    if (!authorizeUrl) return
    await navigator.clipboard.writeText(authorizeUrl)
    setLinkCopied(true)
    window.setTimeout(() => setLinkCopied(false), 1500)
  }

  async function handleScan() {
    setDiscoverLoading(true)
    setScanResult(null)
    setSelectedIds(new Set())
    try {
      const r = await window.api.gateway.scanCodexAccounts()
      setScanResult(r)
      const newIds = new Set(r.candidates.filter((c) => !c.existing).map((c) => c.id))
      setSelectedIds(newIds)
    } finally {
      setDiscoverLoading(false)
    }
  }

  async function handleImportSelected() {
    if (selectedIds.size === 0) return
    setDiscoverLoading(true)
    try {
      await window.api.gateway.importScannedCodexAccounts([...selectedIds])
      setScanResult(null)
      setSelectedIds(new Set())
      onImported()
      onOpenChange(false)
    } finally {
      setDiscoverLoading(false)
    }
  }

  async function handleJson() {
    if (!jsonText.trim()) return
    setJsonLoading(true)
    setJsonResult(null)
    try {
      const r = await window.api.gateway.importCodexJson(jsonText)
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
    <Modal
      open={open}
      onOpenChange={async (v) => {
        if (!v && (loginState === 'pending' || loginState === 'authorize')) {
          await window.api.gateway.cancelCodexLogin()
        }
        if (!v) resetLoginState()
        onOpenChange(v)
      }}
      title={t('addAccount.codexTitle')}
    >
      <TabGroup
        value={tab}
        onValueChange={setTab}
        items={[
          {
            value: 'browser',
            label: t('addAccount.tabs.codexBrowser'),
            content: (
              <div className="space-y-3">
                <p className="text-[12px] text-fog">{t('addAccount.codexBrowserDesc')}</p>
                {loginState === 'idle' && (
                  <Button variant="primary" onClick={handleBrowserLogin}>
                    {t('addAccount.codexLoginBrowser')}
                  </Button>
                )}
                {loginState === 'pending' && (
                  <p className="text-[12px] text-fog animate-pulse">
                    {t('addAccount.codexAwaitingBrowser')}
                  </p>
                )}
                {loginState === 'authorize' && (
                  <div className="space-y-2">
                    <p className="text-[12px] text-fog">
                      {loginMessage || t('addAccount.codexBrowserOpened')}
                    </p>
                    {authorizeUrl && (
                      <div className="flex items-center gap-2 rounded-[var(--radius-md)] bg-pitch px-2 py-1.5">
                        <span className="flex-1 text-[12px] text-lime break-all select-all">
                          {authorizeUrl}
                        </span>
                        <Button size="sm" onClick={handleCopyAuthorizeUrl}>
                          {linkCopied ? t('common.copied') : t('common.copy')}
                        </Button>
                      </div>
                    )}
                    <Button onClick={handleCancelLogin}>{t('common.cancel')}</Button>
                  </div>
                )}
                {loginState === 'success' && (
                  <p className="text-[12px] text-emerald">{t('addAccount.codexLoginSuccess')}</p>
                )}
                {loginState === 'failed' && (
                  <div className="space-y-2">
                    <p className="text-[12px] text-red">{loginMessage}</p>
                    <Button onClick={handleBrowserLogin}>{t('addAccount.codexRetry')}</Button>
                  </div>
                )}
              </div>
            )
          },
          {
            value: 'device',
            label: t('addAccount.tabs.codexDevice'),
            content: (
              <div className="space-y-3">
                <p className="text-[12px] text-fog">{t('addAccount.codexDeviceDesc')}</p>
                {loginState === 'idle' && (
                  <Button variant="primary" onClick={handleDeviceLogin}>
                    {t('addAccount.codexLoginDevice')}
                  </Button>
                )}
                {loginState === 'pending' && (
                  <p className="text-[12px] text-fog animate-pulse">
                    {t('addAccount.codexRequestingCode')}
                  </p>
                )}
                {loginState === 'authorize' && (
                  <div className="space-y-2 text-center py-2">
                    <p className="text-[12px] text-fog">{t('addAccount.codexDeviceCodeHint')}</p>
                    {authorizeUrl && (
                      <div className="flex items-center gap-2 rounded-[var(--radius-md)] bg-pitch px-2 py-1.5 text-left">
                        <span className="flex-1 text-[12px] text-lime break-all select-all">
                          {authorizeUrl}
                        </span>
                        <Button size="sm" onClick={handleCopyAuthorizeUrl}>
                          {linkCopied ? t('common.copied') : t('common.copy')}
                        </Button>
                      </div>
                    )}
                    {userCode && (
                      <p className="text-[22px] font-mono font-[700] text-porcelain tracking-[0.2em]">
                        {userCode}
                      </p>
                    )}
                    <Button onClick={handleCancelLogin}>{t('common.cancel')}</Button>
                  </div>
                )}
                {loginState === 'success' && (
                  <p className="text-[12px] text-emerald">{t('addAccount.codexLoginSuccess')}</p>
                )}
                {loginState === 'failed' && (
                  <div className="space-y-2">
                    <p className="text-[12px] text-red">{loginMessage}</p>
                    <Button onClick={handleDeviceLogin}>{t('addAccount.codexRetry')}</Button>
                  </div>
                )}
              </div>
            )
          },
          {
            value: 'json',
            label: t('addAccount.tabs.json'),
            content: (
              <div className="space-y-2">
                <p className="text-[12px] text-fog">{t('addAccount.codexJsonHint')}</p>
                <textarea
                  className="w-full min-h-[120px] text-[12px] font-mono bg-pitch rounded-[var(--radius-md)] p-2 text-storm"
                  value={jsonText}
                  onChange={(e) => setJsonText(e.target.value)}
                  placeholder={t('addAccount.codexJsonPlaceholder')}
                />
                <div className="flex items-center gap-2">
                  <Button
                    variant="primary"
                    onClick={handleJson}
                    disabled={jsonLoading || !jsonText.trim()}
                  >
                    {jsonLoading ? t('addAccount.jsonImporting') : t('common.add')}
                  </Button>
                  <Button
                    onClick={() => {
                      const input = document.createElement('input')
                      input.type = 'file'
                      input.accept = '.json,application/json'
                      input.onchange = async () => {
                        const file = input.files?.[0]
                        if (!file) return
                        const text = await file.text()
                        setJsonText(text)
                      }
                      input.click()
                    }}
                  >
                    {t('addAccount.jsonSelectFile')}
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
                <p className="text-[12px] text-fog">{t('addAccount.codexDiscoverDesc')}</p>
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
                              {c.email || c.gptWebAccountId || c.sourceType || c.id}
                            </p>
                          </div>
                          <span className="tag text-[12px] !px-1 !py-0 shrink-0">
                            {c.existing ? t('gateway.exists') : c.sourceType || 'codex'}
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
