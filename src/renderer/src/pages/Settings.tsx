import { useEffect, useRef, useState } from 'react'
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

type WindsurfSettingsForm = {
  apiServerUrl: string
  inferenceApiServerUrl: string
  languageServerBinaryPath: string
  codeiumDir: string
  vpnProxyUrl: string
  firstTokenTimeoutSeconds: string
  streamingReadTimeoutSeconds: string
  launchTimeoutSeconds: string
  maxRetries: string
  detectProxy: boolean
}

const DEFAULT_WINDSURF_FORM: WindsurfSettingsForm = {
  apiServerUrl: '',
  inferenceApiServerUrl: '',
  languageServerBinaryPath: '',
  codeiumDir: '.codeium/windsurf',
  vpnProxyUrl: '',
  firstTokenTimeoutSeconds: '60',
  streamingReadTimeoutSeconds: '120',
  launchTimeoutSeconds: '20',
  maxRetries: '2',
  detectProxy: true
}

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
  const [portValue, setPortValue] = useState('')
  const [windsurfSettings, setWindsurfSettings] =
    useState<WindsurfSettingsForm>(DEFAULT_WINDSURF_FORM)
  const [windsurfLoaded, setWindsurfLoaded] = useState(false)
  const portInitRef = useRef(false)
  const portLoaded = portInitRef.current

  if (status && !portInitRef.current) {
    portInitRef.current = true
    setPortValue(String(status.server.port))
  }

  useEffect(() => {
    window.api.gateway.getKiroSettings().then((s: any) => {
      setProxyUrl(s?.vpnProxyUrl || '')
      setProxyLoaded(true)
    })
    window.api.gateway.getWindsurfSettings().then((s: any) => {
      setWindsurfSettings({
        apiServerUrl: s?.apiServerUrl || '',
        inferenceApiServerUrl: s?.inferenceApiServerUrl || '',
        languageServerBinaryPath: s?.languageServerBinaryPath || '',
        codeiumDir: s?.codeiumDir || '.codeium/windsurf',
        vpnProxyUrl: s?.vpnProxyUrl || '',
        firstTokenTimeoutSeconds: String(s?.firstTokenTimeoutSeconds ?? 60),
        streamingReadTimeoutSeconds: String(s?.streamingReadTimeoutSeconds ?? 120),
        launchTimeoutSeconds: String(s?.launchTimeoutSeconds ?? 20),
        maxRetries: String(s?.maxRetries ?? 2),
        detectProxy: s?.detectProxy !== false
      })
      setWindsurfLoaded(true)
    })
    window.api.gateway.getAutoStart().then((v) => {
      setAutoStart(v)
      setAutoStartLoaded(true)
    })
  }, [])

  async function saveProxy(): Promise<void> {
    await run(
      () =>
        Promise.all([
          window.api.gateway.updateKiroSettings({ vpnProxyUrl: proxyUrl }),
          window.api.gateway.updateCodexSettings({ vpnProxyUrl: proxyUrl })
        ]),
      t('settings.saved')
    )
  }

  async function saveWindsurfSettings(): Promise<void> {
    const firstTokenTimeoutSeconds = parsePositiveInt(
      windsurfSettings.firstTokenTimeoutSeconds,
      'First token timeout'
    )
    const streamingReadTimeoutSeconds = parsePositiveInt(
      windsurfSettings.streamingReadTimeoutSeconds,
      'Streaming read timeout'
    )
    const launchTimeoutSeconds = parsePositiveInt(
      windsurfSettings.launchTimeoutSeconds,
      'Launch timeout'
    )
    const maxRetries = parseNonNegativeInt(windsurfSettings.maxRetries, 'Max retries')
    if (
      firstTokenTimeoutSeconds === undefined ||
      streamingReadTimeoutSeconds === undefined ||
      launchTimeoutSeconds === undefined ||
      maxRetries === undefined
    ) {
      return
    }

    await run(
      () =>
        window.api.gateway.updateWindsurfSettings({
          apiServerUrl: windsurfSettings.apiServerUrl.trim(),
          inferenceApiServerUrl: windsurfSettings.inferenceApiServerUrl.trim(),
          languageServerBinaryPath: windsurfSettings.languageServerBinaryPath.trim(),
          codeiumDir: windsurfSettings.codeiumDir.trim() || '.codeium/windsurf',
          vpnProxyUrl: windsurfSettings.vpnProxyUrl.trim(),
          firstTokenTimeoutSeconds,
          streamingReadTimeoutSeconds,
          launchTimeoutSeconds,
          maxRetries,
          detectProxy: windsurfSettings.detectProxy
        }),
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

  function updateWindsurfField<K extends keyof WindsurfSettingsForm>(
    key: K,
    value: WindsurfSettingsForm[K]
  ): void {
    setWindsurfSettings((prev) => ({ ...prev, [key]: value }))
  }

  function parsePositiveInt(value: string, label: string): number | undefined {
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed <= 0) {
      toast(`${label} must be a positive integer`, 'error')
      return undefined
    }
    return parsed
  }

  function parseNonNegativeInt(value: string, label: string): number | undefined {
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < 0) {
      toast(`${label} must be a non-negative integer`, 'error')
      return undefined
    }
    return parsed
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
        <div className="px-3.5 py-2 border-b border-charcoal/60">
          <h2 className="text-[13px] font-medium text-porcelain">{t('settings.windsurfTitle')}</h2>
          <p className="text-[12px] text-fog mt-0.5">{t('settings.windsurfDesc')}</p>
        </div>
        <div className="px-3.5 py-3 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <LabeledInput
              label={t('settings.windsurfApiServerUrl')}
              value={windsurfSettings.apiServerUrl}
              onChange={(value) => updateWindsurfField('apiServerUrl', value)}
              placeholder="https://server.self-serve.windsurf.com"
              disabled={!windsurfLoaded}
            />
            <LabeledInput
              label={t('settings.windsurfInferenceApiServerUrl')}
              value={windsurfSettings.inferenceApiServerUrl}
              onChange={(value) => updateWindsurfField('inferenceApiServerUrl', value)}
              placeholder="https://inference.codeium.com"
              disabled={!windsurfLoaded}
            />
            <LabeledInput
              label={t('settings.windsurfLanguageServerPath')}
              value={windsurfSettings.languageServerBinaryPath}
              onChange={(value) => updateWindsurfField('languageServerBinaryPath', value)}
              placeholder="/Applications/Windsurf.app/.../language_server_macos_arm"
              disabled={!windsurfLoaded}
            />
            <LabeledInput
              label={t('settings.windsurfCodeiumDir')}
              value={windsurfSettings.codeiumDir}
              onChange={(value) => updateWindsurfField('codeiumDir', value)}
              placeholder=".codeium/windsurf"
              disabled={!windsurfLoaded}
            />
            <LabeledInput
              label={t('settings.windsurfProxy')}
              value={windsurfSettings.vpnProxyUrl}
              onChange={(value) => updateWindsurfField('vpnProxyUrl', value)}
              placeholder="socks5://127.0.0.1:1080"
              disabled={!windsurfLoaded}
            />
            <div className="flex items-end justify-between gap-3 rounded-[var(--radius-md)] border border-charcoal/60 bg-pitch/35 px-3 py-2">
              <div>
                <div className="text-[12px] font-medium text-fog">
                  {t('settings.windsurfDetectProxy')}
                </div>
                <div className="text-[11px] text-storm mt-0.5">
                  {t('settings.windsurfDetectProxyDesc')}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={windsurfSettings.detectProxy}
                disabled={!windsurfLoaded}
                className="outline-none focus-visible:ring-1 focus-visible:ring-accent/40 disabled:opacity-40"
                onClick={() => updateWindsurfField('detectProxy', !windsurfSettings.detectProxy)}
              >
                <div
                  className={`relative w-8 h-[18px] rounded-full transition-colors duration-200 ${windsurfSettings.detectProxy ? 'bg-emerald' : 'bg-charcoal border border-ash/60'}`}
                >
                  <div
                    className={`absolute top-[3px] w-3 h-3 rounded-full transition-[left,background-color] duration-200 shadow-sm ${windsurfSettings.detectProxy ? 'left-[17px] bg-white' : 'left-[3px] bg-fog'}`}
                  />
                </div>
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <LabeledInput
              label={t('settings.windsurfFirstTokenTimeout')}
              value={windsurfSettings.firstTokenTimeoutSeconds}
              onChange={(value) =>
                updateWindsurfField('firstTokenTimeoutSeconds', value.replace(/\D/g, ''))
              }
              placeholder="60"
              disabled={!windsurfLoaded}
            />
            <LabeledInput
              label={t('settings.windsurfStreamingTimeout')}
              value={windsurfSettings.streamingReadTimeoutSeconds}
              onChange={(value) =>
                updateWindsurfField('streamingReadTimeoutSeconds', value.replace(/\D/g, ''))
              }
              placeholder="120"
              disabled={!windsurfLoaded}
            />
            <LabeledInput
              label={t('settings.windsurfLaunchTimeout')}
              value={windsurfSettings.launchTimeoutSeconds}
              onChange={(value) =>
                updateWindsurfField('launchTimeoutSeconds', value.replace(/\D/g, ''))
              }
              placeholder="20"
              disabled={!windsurfLoaded}
            />
            <LabeledInput
              label={t('settings.windsurfMaxRetries')}
              value={windsurfSettings.maxRetries}
              onChange={(value) => updateWindsurfField('maxRetries', value.replace(/\D/g, ''))}
              placeholder="2"
              disabled={!windsurfLoaded}
            />
          </div>
          <div className="flex justify-end">
            <Button
              variant="primary"
              disabled={busy || !windsurfLoaded}
              onClick={saveWindsurfSettings}
            >
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

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
  disabled
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="block text-[12px] font-medium text-fog mb-1">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="input-base w-full font-mono"
        disabled={disabled}
      />
    </label>
  )
}
