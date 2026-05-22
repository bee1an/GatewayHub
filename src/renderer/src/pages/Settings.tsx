import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { usePolling } from '../hooks/usePolling'
import { Button } from '../components/ui/Button'
import { SegmentedControl } from '../components/ui/SegmentedControl'
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
  configPath: string
  statePath: string
  providers: Array<{
    name: string
    enabled: boolean
    configured: boolean
    status: string
    models: string[]
  }>
  logs: Array<{ ts: number; level: string; message: string }>
}

type SnippetFormat = 'curl' | 'fetch' | 'python'

function buildSnippet(status: GatewayStatus, format: SnippetFormat): string {
  const url = `${status.server.url}/v1/chat/completions`
  const key = status.server.apiKeys[0]?.key ?? ''
  const body =
    '{"model":"kiro/claude-sonnet-4.5","messages":[{"role":"user","content":"hello"}],"stream":true}'

  if (format === 'curl') {
    return `curl ${url} \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '${body}'`
  }

  if (format === 'fetch') {
    return `const res = await fetch("${url}", {
  method: "POST",
  headers: {
    "Authorization": "Bearer ${key}",
    "Content-Type": "application/json",
  },
  body: JSON.stringify(${body}),
});`
  }

  return `import json
import httpx

body = json.loads(${JSON.stringify(body)})

res = httpx.post(
    "${url}",
    headers={"Authorization": "Bearer ${key}"},
    json=body,
)
print(res.json())`
}

export default function Settings(): React.JSX.Element {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { data: status, refresh } = usePolling<GatewayStatus>(
    () => window.api.gateway.status(),
    5000
  )
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState('')
  const [snippetFormat, setSnippetFormat] = useState<SnippetFormat>('curl')
  const [proxyUrl, setProxyUrl] = useState('')
  const [proxyLoaded, setProxyLoaded] = useState(false)
  const [autoStart, setAutoStart] = useState(false)
  const [autoStartLoaded, setAutoStartLoaded] = useState(false)

  useEffect(() => {
    window.api.gateway.getKiroSettings().then((s: any) => {
      setProxyUrl(s?.vpnProxyUrl || '')
      setProxyLoaded(true)
    })
    window.api.gateway.getAutoStart().then((v) => {
      setAutoStart(v)
      setAutoStartLoaded(true)
    })
  }, [])

  async function saveProxy(): Promise<void> {
    await run(
      () => window.api.gateway.updateKiroSettings({ vpnProxyUrl: proxyUrl }),
      t('settings.saved')
    )
  }

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

  const snippet = status ? buildSnippet(status, snippetFormat) : ''

  return (
    <div className="space-y-4">
      <div>
        <h1 className="section-title">{t('settings.title')}</h1>
        <p className="section-desc">{t('settings.desc')}</p>
      </div>

      <div className="card">
        <div className="px-3.5 py-2 border-b border-charcoal/60">
          <h2 className="text-[13px] font-medium text-porcelain">{t('settings.connection')}</h2>
        </div>
        <div className="px-3.5 py-2.5">
          <div className="grid grid-cols-[72px_1fr_auto] gap-x-3 gap-y-2 text-[12px] items-center">
            <span className="text-fog font-medium">{t('settings.url')}</span>
            <span className="text-storm font-mono truncate">{status?.server.url ?? '—'}</span>
            <Button
              variant="ghost"
              size="sm"
              className="!px-2 !py-0.5"
              onClick={() => copy(status?.server.url ?? '', 'url')}
            >
              {copied === 'url' ? t('common.copied') : t('common.copy')}
            </Button>
            <span className="text-fog font-medium">{t('settings.config')}</span>
            <span className="text-storm font-mono truncate col-span-2" title={status?.configPath}>
              {status?.configPath ?? '—'}
            </span>
            <span className="text-fog font-medium">{t('settings.state')}</span>
            <span className="text-storm font-mono truncate col-span-2" title={status?.statePath}>
              {status?.statePath ?? '—'}
            </span>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="flex items-center justify-between px-3.5 py-2.5">
          <div>
            <h2 className="text-[13px] font-medium text-porcelain">{t('settings.autoStart')}</h2>
            <p className="text-[12px] text-fog mt-0.5">{t('settings.autoStartDesc')}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoStart}
            disabled={!autoStartLoaded}
            className="outline-none focus-visible:ring-1 focus-visible:ring-accent/40 disabled:opacity-40"
            onClick={() => {
              const next = !autoStart
              setAutoStart(next)
              window.api.gateway.setAutoStart(next)
            }}
          >
            <div
              className={`relative w-8 h-[18px] rounded-full transition-colors duration-200 ${autoStart ? 'bg-emerald' : 'bg-charcoal border border-ash/60'}`}
            >
              <div
                className={`absolute top-[3px] w-3 h-3 rounded-full transition-[left,background-color] duration-200 shadow-sm ${autoStart ? 'left-[17px] bg-white' : 'left-[3px] bg-fog'}`}
              />
            </div>
          </button>
        </div>
      </div>

      <div className="card">
        <div className="px-3.5 py-2 border-b border-charcoal/60">
          <h2 className="text-[13px] font-medium text-porcelain">{t('settings.proxy')}</h2>
          <p className="text-[12px] text-fog mt-0.5">{t('settings.proxyDesc')}</p>
        </div>
        <div className="px-3.5 py-2.5">
          <div className="flex items-center gap-3">
            <input
              value={proxyUrl}
              onChange={(e) => setProxyUrl(e.target.value)}
              placeholder="socks5://127.0.0.1:1080"
              className="input-base flex-1 font-mono"
              disabled={!proxyLoaded}
            />
            <Button variant="primary" disabled={busy || !proxyLoaded} onClick={saveProxy}>
              {t('settings.save')}
            </Button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-charcoal/60">
          <div>
            <h2 className="text-[13px] font-medium text-porcelain">{t('settings.quickTest')}</h2>
            <p className="text-[12px] text-fog mt-0.5">{t('settings.quickTestDesc')}</p>
          </div>
          <div className="flex items-center gap-3">
            <SegmentedControl
              value={snippetFormat}
              onValueChange={(v) => setSnippetFormat(v as SnippetFormat)}
              items={[
                { value: 'curl', label: 'curl' },
                { value: 'fetch', label: 'fetch' },
                { value: 'python', label: 'python' }
              ]}
            />
            <Button onClick={() => copy(snippet, 'snippet')}>
              {copied === 'snippet' ? t('common.copied') : t('common.copy')}
            </Button>
          </div>
        </div>
        <div className="p-3">
          <pre className="p-3 pl-4 rounded-[var(--radius-md)] bg-pitch border border-charcoal/60 border-l-[3px] border-l-charcoal/40 text-[12px] font-mono text-storm overflow-x-auto whitespace-pre-wrap leading-[1.65] shadow-[inset_0_1px_3px_rgba(0,0,0,0.2)]">
            {snippet}
          </pre>
        </div>
      </div>
    </div>
  )
}
