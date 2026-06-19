import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../components/ui/Button'
import { useToast } from '../components/ui/ToastContext'

type WindsurfSettingsForm = {
  apiServerUrl: string
  inferenceApiServerUrl: string
  languageServerBinaryPath: string
  codeiumDir: string
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
  firstTokenTimeoutSeconds: '60',
  streamingReadTimeoutSeconds: '120',
  launchTimeoutSeconds: '20',
  maxRetries: '2',
  detectProxy: true
}

function parsePositiveInt(value: string): number | undefined {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined
  return parsed
}

function parseNonNegativeInt(value: string): number | undefined {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) return undefined
  return parsed
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

/**
 * Windsurf provider-level settings (language_server path, API endpoints, proxy,
 * timeouts). Lives on the Windsurf gateway detail page rather than the global
 * Settings page, since these options only apply to the Windsurf provider.
 */
export function WindsurfProviderSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [form, setForm] = useState<WindsurfSettingsForm>(DEFAULT_WINDSURF_FORM)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.gateway.getWindsurfSettings().then((s: any) => {
      if (cancelled) return
      setForm({
        apiServerUrl: s?.apiServerUrl || '',
        inferenceApiServerUrl: s?.inferenceApiServerUrl || '',
        languageServerBinaryPath: s?.languageServerBinaryPath || '',
        codeiumDir: s?.codeiumDir || '.codeium/windsurf',
        firstTokenTimeoutSeconds: String(s?.firstTokenTimeoutSeconds ?? 60),
        streamingReadTimeoutSeconds: String(s?.streamingReadTimeoutSeconds ?? 120),
        launchTimeoutSeconds: String(s?.launchTimeoutSeconds ?? 20),
        maxRetries: String(s?.maxRetries ?? 2),
        detectProxy: s?.detectProxy !== false
      })
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  function updateField<K extends keyof WindsurfSettingsForm>(
    key: K,
    value: WindsurfSettingsForm[K]
  ): void {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function save(): Promise<void> {
    const firstTokenTimeoutSeconds = parsePositiveInt(form.firstTokenTimeoutSeconds)
    const streamingReadTimeoutSeconds = parsePositiveInt(form.streamingReadTimeoutSeconds)
    const launchTimeoutSeconds = parsePositiveInt(form.launchTimeoutSeconds)
    const maxRetries = parseNonNegativeInt(form.maxRetries)
    if (
      firstTokenTimeoutSeconds === undefined ||
      streamingReadTimeoutSeconds === undefined ||
      launchTimeoutSeconds === undefined ||
      maxRetries === undefined
    ) {
      toast('Timeouts must be positive integers and retries a non-negative integer.', 'error')
      return
    }

    setBusy(true)
    try {
      await window.api.gateway.updateWindsurfSettings({
        apiServerUrl: form.apiServerUrl.trim(),
        inferenceApiServerUrl: form.inferenceApiServerUrl.trim(),
        languageServerBinaryPath: form.languageServerBinaryPath.trim(),
        codeiumDir: form.codeiumDir.trim() || '.codeium/windsurf',
        firstTokenTimeoutSeconds,
        streamingReadTimeoutSeconds,
        launchTimeoutSeconds,
        maxRetries,
        detectProxy: form.detectProxy
      })
      toast(t('windsurfSettings.saved'), 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <div className="px-3.5 py-2 border-b border-charcoal/60">
        <h2 className="text-[13px] font-medium text-porcelain">{t('windsurfSettings.title')}</h2>
        <p className="text-[12px] text-fog mt-0.5">{t('windsurfSettings.desc')}</p>
      </div>
      <div className="px-3.5 py-3 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <LabeledInput
            label={t('windsurfSettings.apiServerUrl')}
            value={form.apiServerUrl}
            onChange={(value) => updateField('apiServerUrl', value)}
            placeholder="https://server.self-serve.windsurf.com"
            disabled={!loaded}
          />
          <LabeledInput
            label={t('windsurfSettings.inferenceApiServerUrl')}
            value={form.inferenceApiServerUrl}
            onChange={(value) => updateField('inferenceApiServerUrl', value)}
            placeholder="https://inference.codeium.com"
            disabled={!loaded}
          />
          <LabeledInput
            label={t('windsurfSettings.languageServerPath')}
            value={form.languageServerBinaryPath}
            onChange={(value) => updateField('languageServerBinaryPath', value)}
            placeholder="/Applications/Windsurf.app/.../language_server_macos_arm"
            disabled={!loaded}
          />
          <LabeledInput
            label={t('windsurfSettings.codeiumDir')}
            value={form.codeiumDir}
            onChange={(value) => updateField('codeiumDir', value)}
            placeholder=".codeium/windsurf"
            disabled={!loaded}
          />
          <div className="flex items-end justify-between gap-3 rounded-[var(--radius-md)] border border-charcoal/60 bg-pitch/35 px-3 py-2">
            <div>
              <div className="text-[12px] font-medium text-fog">
                {t('windsurfSettings.detectProxy')}
              </div>
              <div className="text-[11px] text-storm mt-0.5">
                {t('windsurfSettings.detectProxyDesc')}
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={form.detectProxy}
              disabled={!loaded}
              className="outline-none focus-visible:ring-1 focus-visible:ring-accent/40 disabled:opacity-40"
              onClick={() => updateField('detectProxy', !form.detectProxy)}
            >
              <div
                className={`relative w-8 h-[18px] rounded-full transition-colors duration-200 ${form.detectProxy ? 'bg-emerald' : 'bg-charcoal border border-ash/60'}`}
              >
                <div
                  className={`absolute top-[3px] w-3 h-3 rounded-full transition-[left,background-color] duration-200 shadow-sm ${form.detectProxy ? 'left-[17px] bg-white' : 'left-[3px] bg-fog'}`}
                />
              </div>
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <LabeledInput
            label={t('windsurfSettings.firstTokenTimeout')}
            value={form.firstTokenTimeoutSeconds}
            onChange={(value) => updateField('firstTokenTimeoutSeconds', value.replace(/\D/g, ''))}
            placeholder="60"
            disabled={!loaded}
          />
          <LabeledInput
            label={t('windsurfSettings.streamingTimeout')}
            value={form.streamingReadTimeoutSeconds}
            onChange={(value) =>
              updateField('streamingReadTimeoutSeconds', value.replace(/\D/g, ''))
            }
            placeholder="120"
            disabled={!loaded}
          />
          <LabeledInput
            label={t('windsurfSettings.launchTimeout')}
            value={form.launchTimeoutSeconds}
            onChange={(value) => updateField('launchTimeoutSeconds', value.replace(/\D/g, ''))}
            placeholder="20"
            disabled={!loaded}
          />
          <LabeledInput
            label={t('windsurfSettings.maxRetries')}
            value={form.maxRetries}
            onChange={(value) => updateField('maxRetries', value.replace(/\D/g, ''))}
            placeholder="2"
            disabled={!loaded}
          />
        </div>
        <div className="flex justify-end">
          <Button variant="primary" disabled={busy || !loaded} onClick={save}>
            {t('settings.save')}
          </Button>
        </div>
      </div>
    </div>
  )
}
