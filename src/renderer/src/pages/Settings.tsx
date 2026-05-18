import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { usePolling } from '../hooks/usePolling'
import { Button } from '../components/ui/Button'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { useToast } from '../components/ui/ToastContext'

type GatewayStatus = {
  server: { running: boolean; url: string; host: string; port: number; apiKey: string }
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
  const key = status.server.apiKey
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
  const [showKey, setShowKey] = useState(false)
  const [copied, setCopied] = useState('')
  const [snippetFormat, setSnippetFormat] = useState<SnippetFormat>('curl')
  const [proxyUrl, setProxyUrl] = useState('')
  const [proxyLoaded, setProxyLoaded] = useState(false)

  useEffect(() => {
    window.api.gateway.getKiroSettings().then((s: any) => {
      setProxyUrl(s?.vpnProxyUrl || '')
      setProxyLoaded(true)
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
    <div className="space-y-5">
      <div>
        <h1 className="section-title">{t('settings.title')}</h1>
        <p className="section-desc">{t('settings.desc')}</p>
      </div>

      <div className="card">
        <div className="flex items-center justify-between px-4 py-3 border-b border-charcoal">
          <div className="flex items-center gap-3">
            <span className={status?.server.running ? 'pulse-dot-green' : 'pulse-dot-gray'} />
            <div>
              <h2 className="text-[13px] font-[510] text-porcelain">{t('settings.serverTitle')}</h2>
              <span className="text-[12px] text-fog">
                {status?.server.running ? t('settings.running') : t('settings.stoppedStatus')}
              </span>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="primary"
              disabled={busy || status?.server.running}
              onClick={() => run(() => window.api.gateway.start(), t('settings.started'))}
            >
              {t('common.start')}
            </Button>
            <Button
              disabled={busy || !status?.server.running}
              onClick={() => run(() => window.api.gateway.stop(), t('settings.stopped'))}
            >
              {t('common.stop')}
            </Button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="px-4 py-3 border-b border-charcoal">
          <h2 className="text-[13px] font-[510] text-porcelain">{t('settings.connection')}</h2>
        </div>
        <div className="px-4 py-3">
          <div className="grid grid-cols-[80px_1fr_auto] gap-x-4 gap-y-3 text-[12px] items-center">
            <span className="text-fog font-[510]">{t('settings.url')}</span>
            <span className="text-storm font-mono">{status?.server.url ?? '—'}</span>
            <Button
              variant="ghost"
              size="sm"
              className="!px-2 !py-0.5"
              onClick={() => copy(status?.server.url ?? '', 'url')}
            >
              {copied === 'url' ? t('common.copied') : t('common.copy')}
            </Button>

            <span className="text-fog font-[510]">{t('settings.apiKey')}</span>
            <span
              className="text-storm font-mono break-all cursor-pointer"
              onClick={() => setShowKey(!showKey)}
            >
              {showKey ? status?.server.apiKey : '••••••••••••••••'}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="!px-2 !py-0.5"
              onClick={() => copy(status?.server.apiKey ?? '', 'key')}
            >
              {copied === 'key' ? t('common.copied') : t('common.copy')}
            </Button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="px-4 py-3 border-b border-charcoal">
          <h2 className="text-[13px] font-[510] text-porcelain">{t('settings.paths')}</h2>
        </div>
        <div className="px-4 py-3">
          <div className="grid grid-cols-[80px_1fr] gap-x-4 gap-y-2 text-[12px]">
            <span className="text-fog font-[510]">{t('settings.config')}</span>
            <span className="text-storm font-mono break-all">{status?.configPath ?? '—'}</span>
            <span className="text-fog font-[510]">{t('settings.state')}</span>
            <span className="text-storm font-mono break-all">{status?.statePath ?? '—'}</span>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="px-4 py-3 border-b border-charcoal">
          <h2 className="text-[13px] font-[510] text-porcelain">{t('settings.proxy')}</h2>
          <p className="text-[12px] text-fog mt-0.5">{t('settings.proxyDesc')}</p>
        </div>
        <div className="px-4 py-3">
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
        <div className="flex items-center justify-between px-4 py-3 border-b border-charcoal">
          <div>
            <h2 className="text-[13px] font-[510] text-porcelain">{t('settings.quickTest')}</h2>
            <p className="text-[12px] text-fog mt-0.5">{t('settings.quickTestDesc')}</p>
          </div>
          <div className="flex items-center gap-2">
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
        <div className="p-4">
          <pre className="p-3 rounded-[var(--radius-md)] bg-pitch border border-charcoal text-[12px] font-mono text-storm overflow-x-auto whitespace-pre-wrap leading-relaxed">
            {snippet}
          </pre>
        </div>
      </div>
    </div>
  )
}
