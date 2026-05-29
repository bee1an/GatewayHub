import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { TabGroup } from '../components/ui/TabGroup'

export function AddKiroAccountDialog({
  open,
  onOpenChange,
  onImported
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  busy: boolean
  onAdd: (action: () => Promise<any>, msg: string) => Promise<void>
  onImported: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState('cli')

  // Discover tab
  const [discoverLoading, setDiscoverLoading] = useState(false)
  const [scanResult, setScanResult] = useState<{
    candidates: Array<{
      id: string
      label?: string
      email?: string
      refreshToken?: string
      profileArn?: string
      existing?: boolean
      sourceType?: string
    }>
  } | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Token tab
  const [tokenText, setTokenText] = useState('')
  const [tokenType, setTokenType] = useState<'refresh' | 'access'>('refresh')
  const [tokenLoading, setTokenLoading] = useState(false)
  const [tokenMsg, setTokenMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // JSON tab
  const [jsonText, setJsonText] = useState('')
  const [jsonLoading, setJsonLoading] = useState(false)
  const [jsonResult, setJsonResult] = useState<{
    added: number
    skipped: number
    errors: string[]
  } | null>(null)

  // CLI tab
  const [cliState, setCliState] = useState<
    'detecting' | 'found' | 'not_found' | 'logging_in' | 'success' | 'failed'
  >('detecting')
  const [cliPath, setCliPath] = useState('')
  const [cliVersion, setCliVersion] = useState('')
  const [cliOutput, setCliOutput] = useState('')
  const [cliExitCode, setCliExitCode] = useState<number | null>(null)
  const [cliCopyOk, setCliCopyOk] = useState(false)

  useEffect(() => {
    if (open && tab === 'cli' && cliState === 'detecting') {
      window.api.gateway.detectKiroCli().then((r) => {
        if (r.found) {
          setCliState('found')
          setCliPath(r.path)
          setCliVersion(r.version || '')
        } else {
          setCliState('not_found')
        }
      })
    }
  }, [open, tab, cliState])

  useEffect(() => {
    if (cliState !== 'logging_in') return
    let output = ''
    const unsub = window.api.gateway.onCliLoginOutput((data) => {
      if (data.type === 'stdout' || data.type === 'stderr') {
        output += data.text || ''
        setCliOutput((prev) => prev + (data.text || ''))
      } else if (data.type === 'exit') {
        const alreadyLoggedIn = /already logged in/i.test(output)
        if (data.code === 0 || alreadyLoggedIn) {
          if (data.imported) {
            setCliState('success')
            onImported()
            onOpenChange(false)
          } else {
            setCliState('failed')
            setCliOutput((prev) => prev + (data.error || 'Failed to extract credentials from CLI'))
            setCliExitCode(-1)
          }
        } else {
          setCliState('failed')
          setCliExitCode(data.code ?? -1)
        }
      } else if (data.type === 'error') {
        setCliState('failed')
        setCliOutput((prev) => prev + (data.message || ''))
      }
    })
    return unsub
  }, [cliState, onImported, onOpenChange])

  async function handleScan() {
    setDiscoverLoading(true)
    setScanResult(null)
    setSelectedIds(new Set())
    try {
      const r = await window.api.gateway.scanKiroAccounts()
      setScanResult(r)
      const newIds = new Set(r.candidates.filter((c: any) => !c.existing).map((c: any) => c.id))
      setSelectedIds(newIds)
    } finally {
      setDiscoverLoading(false)
    }
  }

  async function handleImportSelected() {
    setDiscoverLoading(true)
    try {
      await window.api.gateway.importScannedAccounts([...selectedIds])
      setScanResult(null)
      setSelectedIds(new Set())
      onOpenChange(false)
      onImported()
    } finally {
      setDiscoverLoading(false)
    }
  }

  async function handleToken() {
    if (!tokenText.trim()) return
    setTokenLoading(true)
    setTokenMsg(null)
    try {
      if (tokenType === 'access') {
        await window.api.gateway.addKiroAccessToken(tokenText)
      } else {
        await window.api.gateway.addKiroRefreshToken(tokenText)
      }
      setTokenMsg({ ok: true, text: t('addAccount.tokenValid') })
      setTokenText('')
      onImported()
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
      const r = await window.api.gateway.importKiroJson(jsonText)
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

  function handleCliLogin() {
    setCliState('logging_in')
    setCliOutput('')
    setCliExitCode(null)
    setCliCopyOk(false)
    window.api.gateway.loginWithKiroCli({ cliPath: cliPath || undefined })
  }

  async function handleCopyCliLink(link: string) {
    await navigator.clipboard.writeText(link)
    setCliCopyOk(true)
    window.setTimeout(() => setCliCopyOk(false), 1500)
  }

  function handleCliCancel() {
    window.api.gateway.cancelKiroCliLogin()
    setCliState('found')
    setCliOutput('')
  }

  return (
    <Modal
      open={open}
      onOpenChange={(v) => {
        if (!v && cliState === 'logging_in') {
          window.api.gateway.cancelKiroCliLogin()
          setCliState('found')
          setCliOutput('')
        }
        onOpenChange(v)
      }}
      title={t('addAccount.title')}
    >
      <TabGroup
        value={tab}
        onValueChange={setTab}
        items={[
          {
            value: 'cli',
            label: t('addAccount.tabs.cli'),
            content: (
              <>
                {cliState === 'detecting' && (
                  <p className="text-[12px] text-fog">{t('addAccount.cliDetecting')}</p>
                )}
                {cliState === 'not_found' && (
                  <div className="space-y-1">
                    <p className="text-[12px] text-warning">{t('addAccount.cliNotFound')}</p>
                    <p className="text-[12px] text-fog">{t('addAccount.cliInstallHint')}</p>
                  </div>
                )}
                {(cliState === 'found' || cliState === 'success' || cliState === 'failed') && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] text-fog">
                        {t('addAccount.cliFound', { path: cliPath })}
                      </span>
                      {cliVersion && <span className="tag text-[12px]">{cliVersion}</span>}
                    </div>
                    {cliState === 'found' && (
                      <Button variant="primary" onClick={handleCliLogin}>
                        {t('addAccount.cliLogin')}
                      </Button>
                    )}
                    {cliState === 'success' && (
                      <p className="text-[12px] text-emerald">{t('addAccount.cliSuccess')}</p>
                    )}
                    {cliState === 'failed' && (
                      <p className="text-[12px] text-red">
                        {t('addAccount.cliFailed', { code: cliExitCode })}
                      </p>
                    )}
                  </div>
                )}
                {cliState === 'logging_in' && (
                  <div className="space-y-2">
                    {(() => {
                      const codeMatch = cliOutput.match(/Code:\s*([A-Z0-9-]+)/i)
                      const urlMatch = cliOutput.match(/https?:\/\/[^\s]+/)
                      const verifyUrl =
                        urlMatch?.[0] || 'https://device.sso.us-east-1.amazonaws.com/'
                      return (
                        <>
                          {codeMatch ? (
                            <div className="space-y-2 text-center py-2">
                              <p className="text-[12px] text-fog">
                                复制下面的链接到你想使用的浏览器，并输入验证码：
                              </p>
                              <div className="flex items-center gap-2 rounded-[var(--radius-md)] bg-pitch px-2 py-1.5 text-left">
                                <span className="flex-1 text-[12px] text-lime break-all select-all">
                                  {verifyUrl}
                                </span>
                                <Button size="sm" onClick={() => handleCopyCliLink(verifyUrl)}>
                                  {cliCopyOk ? '已复制' : '复制'}
                                </Button>
                              </div>
                              <p className="text-[22px] font-mono font-[700] text-porcelain tracking-[0.2em]">
                                {codeMatch[1]}
                              </p>
                              <p className="text-[12px] text-fog animate-pulse">等待验证完成...</p>
                            </div>
                          ) : (
                            <pre className="text-[12px] font-mono bg-pitch rounded-[var(--radius-md)] p-3 max-h-36 overflow-y-auto whitespace-pre-wrap text-storm">
                              {cliOutput || '...'}
                            </pre>
                          )}
                        </>
                      )
                    })()}
                    <Button onClick={handleCliCancel}>{t('addAccount.cliCancel')}</Button>
                  </div>
                )}
              </>
            )
          },
          {
            value: 'token',
            label: t('addAccount.tabs.token'),
            content: (
              <>
                <SegmentedControl
                  value={tokenType}
                  onValueChange={(v) => setTokenType(v as 'refresh' | 'access')}
                  items={[
                    { value: 'refresh', label: 'Refresh Token' },
                    { value: 'access', label: 'Access Token' }
                  ]}
                />
                <textarea
                  value={tokenText}
                  onChange={(e) => setTokenText(e.target.value)}
                  placeholder={
                    tokenType === 'refresh'
                      ? t('addAccount.tokenPlaceholder')
                      : t('addAccount.accessTokenPlaceholder')
                  }
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
              </>
            )
          },
          {
            value: 'json',
            label: t('addAccount.tabs.json'),
            content: (
              <>
                <textarea
                  value={jsonText}
                  onChange={(e) => setJsonText(e.target.value)}
                  placeholder={t('addAccount.jsonPlaceholder')}
                  className="input-base font-mono text-[12px] min-h-24 resize-y w-full"
                />
                <div className="flex items-center gap-3">
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
                      {t('addAccount.jsonResult', jsonResult)}
                    </span>
                  )}
                </div>
                {jsonResult && jsonResult.errors.length > 0 && (
                  <div className="text-[12px] text-red space-y-0.5 max-h-40 overflow-y-auto">
                    <p>{t('addAccount.jsonErrors', { count: jsonResult.errors.length })}</p>
                    {jsonResult.errors.map((e, i) => (
                      <p key={i} className="opacity-80 break-all whitespace-pre-wrap">
                        {e}
                      </p>
                    ))}
                  </div>
                )}
              </>
            )
          },
          {
            value: 'discover',
            label: t('addAccount.tabs.discover'),
            content: (
              <>
                <p className="text-[12px] text-fog">{t('gateway.discoverTip')}</p>
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
                    <div className="space-y-1">
                      {scanResult.candidates.map((c) => (
                        <label
                          key={c.id}
                          className={`flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-sm)] ${c.existing ? 'opacity-40' : 'hover:bg-[color-mix(in_srgb,var(--c-slate)_30%,transparent)]'}`}
                        >
                          <input
                            type="checkbox"
                            checked={selectedIds.has(c.id)}
                            disabled={c.existing}
                            onChange={(e) => {
                              const next = new Set(selectedIds)
                              if (e.target.checked) next.add(c.id)
                              else next.delete(c.id)
                              setSelectedIds(next)
                            }}
                            className="custom-checkbox"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="text-[12px] text-porcelain truncate">
                              {c.label || c.email || c.id}
                            </p>
                            <p className="text-[12px] text-fog font-mono truncate">
                              {c.email ||
                                (c.refreshToken
                                  ? c.refreshToken.slice(0, 20) + '...'
                                  : c.sourceType || c.id)}
                            </p>
                          </div>
                          <span className="tag text-[12px] !px-1 !py-0 shrink-0">
                            {c.existing ? t('gateway.exists') : c.sourceType || 'account'}
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
              </>
            )
          }
        ]}
      />
    </Modal>
  )
}
