import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { usePolling } from '../hooks/usePolling'
import { Button } from '../components/ui/Button'
import { SegmentedControl } from '../components/ui/SegmentedControl'
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

/** 把配置里的 host 字符串归一到 UI 上的两档：回环 → loopback，其余 → lan。 */
function hostToMode(host: string | undefined): 'loopback' | 'lan' {
  const h = (host || '').toLowerCase()
  return h === '127.0.0.1' || h === '::1' || h === 'localhost' ? 'loopback' : 'lan'
}

function buildSnippet(status: GatewayStatus, format: SnippetFormat): string {
  const url = `${status.server.url}/v1/chat/completions`
  const placeholder = 'YOUR_API_KEY'
  const body =
    '{"model":"kiro/claude-sonnet-4.5","messages":[{"role":"user","content":"hello"}],"stream":true}'

  if (format === 'curl') {
    return `curl ${url} \\
  -H "Authorization: Bearer ${placeholder}" \\
  -H "Content-Type: application/json" \\
  -d '${body}'`
  }

  if (format === 'fetch') {
    return `const res = await fetch("${url}", {
  method: "POST",
  headers: {
    "Authorization": "Bearer ${placeholder}",
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
    headers={"Authorization": "Bearer ${placeholder}"},
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
  const [portValue, setPortValue] = useState('')
  const portInitRef = useRef(false)
  const portLoaded = portInitRef.current
  // 监听地址：'loopback' (127.0.0.1) | 'lan' (0.0.0.0)
  const [hostValue, setHostValue] = useState<'loopback' | 'lan'>('loopback')
  const hostInitRef = useRef(false)
  const hostLoaded = hostInitRef.current
  const [hostConfirmOpen, setHostConfirmOpen] = useState(false)

  // 当前配置是否为回环（非回环一律视为 LAN，覆盖 0.0.0.0 / :: / 具体 IP 等情况）
  if (status && !hostInitRef.current) {
    hostInitRef.current = true
    setHostValue(hostToMode(status.server.host))
  }

  if (status && !portInitRef.current) {
    portInitRef.current = true
    setPortValue(String(status.server.port))
  }

  useEffect(() => {
    window.api.gateway.getProxyUrl().then((url) => {
      setProxyUrl(url || '')
      setProxyLoaded(true)
    })
    window.api.gateway.getAutoStart().then((v) => {
      setAutoStart(v)
      setAutoStartLoaded(true)
    })
  }, [])

  async function saveProxy(): Promise<void> {
    await run(() => window.api.gateway.setProxyUrl(proxyUrl.trim()), t('settings.saved'))
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
            onClick={async () => {
              const next = !autoStart
              setAutoStart(next)
              try {
                await window.api.gateway.setAutoStart(next)
              } catch (err) {
                setAutoStart(!next)
                toast(err instanceof Error ? err.message : String(err), 'error')
              }
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
        <div className="flex items-center justify-between px-3.5 py-2.5">
          <div className="min-w-0">
            <h2
              id="settings-listen-address-label"
              className="text-[13px] font-medium text-porcelain"
            >
              {t('settings.listenAddress')}
            </h2>
            <p className="text-[12px] text-fog mt-0.5">{t('settings.listenAddressDesc')}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={hostValue === 'lan'}
            aria-labelledby="settings-listen-address-label"
            disabled={!hostLoaded || busy}
            className="outline-none focus-visible:ring-1 focus-visible:ring-accent/40 disabled:opacity-40 shrink-0"
            onClick={() => {
              const next = hostValue === 'lan' ? 'loopback' : 'lan'
              setHostValue(next)
              if (next === 'lan') {
                setHostConfirmOpen(true)
              } else {
                void run(() => window.api.gateway.setHost('127.0.0.1'), t('settings.saved'))
              }
            }}
          >
            <div
              className={`relative w-8 h-[18px] rounded-full transition-colors duration-200 ${hostValue === 'lan' ? 'bg-warning' : 'bg-charcoal border border-ash/60'}`}
            >
              <div
                className={`absolute top-[3px] w-3 h-3 rounded-full transition-[left,background-color] duration-200 shadow-sm ${hostValue === 'lan' ? 'left-[17px] bg-white' : 'left-[3px] bg-fog'}`}
              />
            </div>
          </button>
        </div>
        {hostValue === 'lan' && (
          <div className="px-3.5 pb-2.5 -mt-0.5">
            <p className="text-[12px] text-warning">{t('settings.listenLanWarning')}</p>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={hostConfirmOpen}
        onOpenChange={(open) => {
          setHostConfirmOpen(open)
          // Cancelling the LAN-confirmation must roll the switch back to whatever
          // is currently applied, otherwise the toggle would read "on" while the
          // server is still bound to loopback.
          if (!open) setHostValue(hostToMode(status?.server.host))
        }}
        title={t('settings.listenLanConfirmTitle')}
        description={t('settings.listenLanConfirmDesc')}
        confirmLabel={t('settings.save')}
        cancelLabel={t('common.cancel')}
        variant="danger"
        loading={busy}
        onConfirm={async () => {
          setHostConfirmOpen(false)
          await run(() => window.api.gateway.setHost('0.0.0.0'), t('settings.saved'))
        }}
      />

      <div className="card">
        <div className="px-3.5 py-2 border-b border-charcoal/60">
          <h2 className="text-[13px] font-medium text-porcelain">{t('settings.port')}</h2>
          <p className="text-[12px] text-fog mt-0.5">{t('settings.portDesc')}</p>
        </div>
        <div className="px-3.5 py-2.5">
          <div className="flex items-center gap-3">
            <input
              value={portValue}
              onChange={(e) => setPortValue(e.target.value.replace(/\D/g, ''))}
              placeholder="9741"
              className="input-base w-32 font-mono"
              disabled={!portLoaded}
            />
            <Button
              variant="primary"
              disabled={
                busy || !portLoaded || portValue === String(status?.server.port) || !portValue
              }
              onClick={async () => {
                const p = Number(portValue)
                if (p < 1 || p > 65535) {
                  toast(t('settings.portInvalid'), 'error')
                  return
                }
                await run(() => window.api.gateway.setPort(p), t('settings.saved'))
              }}
            >
              {t('settings.save')}
            </Button>
          </div>
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

      <div className="card">
        <div className="px-3.5 py-2 border-b border-charcoal/60">
          <h2 className="text-[13px] font-medium text-porcelain">{t('settings.about')}</h2>
        </div>
        <div className="px-3.5 py-2.5">
          <div className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-2 text-[12px] items-center">
            <span className="text-fog font-medium">{t('settings.version')}</span>
            <span className="text-storm font-mono">v{window.api.appVersion || '—'}</span>
            <span className="text-fog font-medium">GitHub</span>
            <a
              href="https://github.com/bee1an/GatewayHub"
              target="_blank"
              rel="noopener noreferrer"
              className="text-storm hover:text-porcelain transition-colors font-mono truncate"
            >
              bee1an/GatewayHub
              <span className="i-ph-arrow-square-out ml-1 text-[10px] inline-block align-middle text-fog" />
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}
