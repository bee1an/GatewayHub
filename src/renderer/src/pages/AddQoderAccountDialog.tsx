import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { TabGroup } from '../components/ui/TabGroup'

export function AddQoderAccountDialog({
  open,
  onOpenChange,
  onImported
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onImported: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState('pat')
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

  const [cliState, setCliState] = useState<
    'detecting' | 'found' | 'not_found' | 'logging_in' | 'success' | 'failed'
  >('detecting')
  const [cliPath, setCliPath] = useState('')
  const [cliVersion, setCliVersion] = useState('')
  const [cliOutput, setCliOutput] = useState('')
  const [cliExitCode, setCliExitCode] = useState<number | null>(null)
  const [cliCopyOk, setCliCopyOk] = useState(false)
  const [cliImporting, setCliImporting] = useState(false)
  const [cliImportMsg, setCliImportMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    if (open && tab === 'cli' && cliState === 'detecting') {
      window.api.gateway.detectQoderCli().then((r) => {
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
    const unsub = window.api.gateway.onCliLoginOutput((data) => {
      if (data.type === 'stdout' || data.type === 'stderr') {
        setCliOutput((prev) => prev + (data.text || ''))
      } else if (data.type === 'exit') {
        if (data.code === 0 && data.imported) {
          setCliState('success')
          onImported()
          onOpenChange(false)
        } else {
          setCliState('failed')
          setCliExitCode(data.code ?? -1)
          if (data.error) setCliOutput((prev) => `${prev}\n${data.error}`)
        }
      } else if (data.type === 'error') {
        setCliState('failed')
        setCliOutput((prev) => `${prev}\n${data.message || ''}`)
      }
    })
    return unsub
  }, [cliState, onImported, onOpenChange])

  async function handleToken(): Promise<void> {
    if (!tokenText.trim()) return
    setTokenLoading(true)
    setTokenMsg(null)
    try {
      throwIfIpcError(await window.api.gateway.addQoderPersonalAccessToken(tokenText.trim()))
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

  function handleCliLogin(): void {
    setCliState('logging_in')
    setCliOutput('')
    setCliExitCode(null)
    setCliCopyOk(false)
    setCliImportMsg(null)
    window.api.gateway.loginWithQoderCli({ cliPath: cliPath || undefined }).then((result: any) => {
      if (result?.ok === false) {
        setCliState('failed')
        setCliOutput(result.error || t('addAccount.tokenInvalid'))
      }
    })
  }

  async function handleImportCurrentCli(): Promise<void> {
    setCliImporting(true)
    setCliImportMsg(null)
    try {
      throwIfIpcError(
        await window.api.gateway.addQoderCliLogin({ qoderCliPath: cliPath || undefined })
      )
      setCliImportMsg({ ok: true, text: t('addAccount.qoderCliImportSuccess') })
      onImported()
      onOpenChange(false)
    } catch (err: any) {
      setCliImportMsg({ ok: false, text: err?.message || t('addAccount.tokenInvalid') })
    } finally {
      setCliImporting(false)
    }
  }

  async function handleCopyCliLink(link: string): Promise<void> {
    await navigator.clipboard.writeText(link)
    setCliCopyOk(true)
    window.setTimeout(() => setCliCopyOk(false), 1500)
  }

  function handleCliCancel(): void {
    window.api.gateway.cancelQoderCliLogin()
    setCliState('found')
    setCliOutput('')
  }

  async function handleJson(): Promise<void> {
    if (!jsonText.trim()) return
    setJsonLoading(true)
    setJsonResult(null)
    try {
      const r = await window.api.gateway.importQoderJson(jsonText)
      throwIfIpcError(r)
      setJsonResult({ added: r.added, skipped: r.skipped, errors: r.errors || [] })
      if (r.added > 0 || r.skipped > 0) {
        setJsonText('')
        onImported()
        if (r.added > 0) onOpenChange(false)
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
      onOpenChange={(v) => {
        if (!v && cliState === 'logging_in') {
          window.api.gateway.cancelQoderCliLogin()
          setCliState('found')
          setCliOutput('')
        }
        onOpenChange(v)
      }}
      title={t('addAccount.qoderTitle')}
    >
      <TabGroup
        value={tab}
        onValueChange={setTab}
        items={[
          {
            value: 'cli',
            label: t('addAccount.qoderCliAdd'),
            content: (
              <div className="space-y-3">
                <p className="text-[12px] text-fog">{t('addAccount.qoderCliHint')}</p>
                {cliState === 'detecting' && (
                  <p className="text-[12px] text-fog">{t('addAccount.qoderCliDetecting')}</p>
                )}
                {cliState === 'not_found' && (
                  <div className="space-y-1">
                    <p className="text-[12px] text-warning">{t('addAccount.qoderCliNotFound')}</p>
                    <p className="text-[12px] text-fog">{t('addAccount.qoderCliInstallHint')}</p>
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
                      <div className="flex flex-wrap items-center gap-2">
                        <Button variant="primary" onClick={handleCliLogin}>
                          {t('addAccount.qoderCliLoginNew')}
                        </Button>
                        <Button onClick={handleImportCurrentCli} disabled={cliImporting}>
                          {cliImporting
                            ? t('addAccount.jsonImporting')
                            : t('addAccount.qoderCliImportCurrent')}
                        </Button>
                      </div>
                    )}
                    {cliState === 'success' && (
                      <p className="text-[12px] text-emerald">{t('addAccount.cliSuccess')}</p>
                    )}
                    {cliState === 'failed' && (
                      <p className="text-[12px] text-red">
                        {t('addAccount.cliFailed', { code: cliExitCode })}
                      </p>
                    )}
                    {cliImportMsg && (
                      <p className={`text-[12px] ${cliImportMsg.ok ? 'text-emerald' : 'text-red'}`}>
                        {cliImportMsg.text}
                      </p>
                    )}
                  </div>
                )}
                {cliState === 'logging_in' && (
                  <div className="space-y-2">
                    {(() => {
                      const urlMatch = cliOutput.match(/https?:\/\/[^\s]+/)
                      const loginUrl = urlMatch?.[0]
                      return loginUrl ? (
                        <div className="space-y-2 text-center py-2">
                          <p className="text-[12px] text-fog">
                            {t('addAccount.qoderCliLoginHint')}
                          </p>
                          <div className="flex items-center gap-2 rounded-[var(--radius-md)] bg-pitch px-2 py-1.5 text-left">
                            <span className="flex-1 text-[12px] text-lime break-all select-all">
                              {loginUrl}
                            </span>
                            <Button size="sm" onClick={() => handleCopyCliLink(loginUrl)}>
                              {cliCopyOk ? t('common.copied') : t('common.copy')}
                            </Button>
                          </div>
                          <p className="text-[12px] text-fog animate-pulse">
                            {t('addAccount.qoderCliWaiting')}
                          </p>
                        </div>
                      ) : (
                        <pre className="text-[12px] font-mono bg-pitch rounded-[var(--radius-md)] p-3 max-h-36 overflow-y-auto whitespace-pre-wrap text-storm">
                          {cliOutput || '...'}
                        </pre>
                      )
                    })()}
                    <Button onClick={handleCliCancel}>{t('addAccount.cliCancel')}</Button>
                  </div>
                )}
              </div>
            )
          },
          {
            value: 'pat',
            label: t('addAccount.tabs.personalAccessToken'),
            content: (
              <div className="space-y-3">
                <p className="text-[12px] text-fog">{t('addAccount.qoderTokenHint')}</p>
                <textarea
                  value={tokenText}
                  onChange={(e) => setTokenText(e.target.value)}
                  placeholder={t('addAccount.qoderTokenPlaceholder')}
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
                <p className="text-[12px] text-fog">{t('addAccount.qoderJsonHint')}</p>
                <textarea
                  className="w-full min-h-[120px] text-[12px] font-mono bg-pitch rounded-[var(--radius-md)] p-2 text-storm"
                  value={jsonText}
                  onChange={(e) => setJsonText(e.target.value)}
                  placeholder={t('addAccount.qoderJsonPlaceholder')}
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

function throwIfIpcError(result: any): void {
  if (result?.ok === false) throw new Error(result.error || 'Operation failed')
}
