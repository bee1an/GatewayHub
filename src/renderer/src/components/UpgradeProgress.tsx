import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from './ui/Button'

type Phase = 'download' | 'install' | 'success' | 'error'

export function UpgradeProgress(): React.JSX.Element {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<Phase>('download')
  const [errorMessage, setErrorMessage] = useState<string>('')
  const [logLines, setLogLines] = useState<string[]>([])
  const logRef = useRef<HTMLDivElement>(null)
  const installAckedRef = useRef(false)

  useEffect(() => {
    const off = window.api.upgrade.onEvent((event) => {
      if (event.kind === 'phase') setPhase(event.phase)
      else if (event.kind === 'log') {
        const incoming = event.text.split(/\r?\n/).filter((line) => line.length > 0)
        if (incoming.length === 0) return
        setLogLines((prev) => [...prev, ...incoming].slice(-200))
      } else if (event.kind === 'error') {
        setErrorMessage(event.message)
      }
    })
    // 监听器已就绪，通知 main 开始派发缓冲事件
    window.api.upgrade.notifyReady()
    return off
  }, [])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logLines])

  // install phase 已 commit 到屏幕后通知 main，可以开始跑 brew upgrade
  useEffect(() => {
    if (phase !== 'install' || installAckedRef.current) return
    installAckedRef.current = true
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.api.upgrade.notifyInstallRendered()
      })
    })
  }, [phase])

  const isError = phase === 'error'
  const isSuccess = phase === 'success'
  const phaseLabel = isError
    ? t('updater.progress.phaseError')
    : isSuccess
      ? t('updater.progress.phaseSuccess')
      : phase === 'install'
        ? t('updater.progress.phaseInstall')
        : t('updater.progress.phaseDownload')

  const iconClass = isError
    ? 'i-ph-warning-circle-bold text-rose text-lg'
    : isSuccess
      ? 'i-ph-check-circle-bold text-emerald text-lg'
      : 'i-ph-arrow-circle-up-bold text-emerald text-lg animate-pulse'

  return (
    <div className="h-screen w-screen flex flex-col bg-pitch text-porcelain select-none">
      <div className="h-8 w-full" style={{ ['WebkitAppRegion' as string]: 'drag' }} />
      <div className="flex-1 flex flex-col gap-3 px-5 pb-5">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-[var(--radius-md)] bg-[color-mix(in_srgb,var(--c-emerald)_15%,transparent)]">
            <span className={iconClass} />
          </div>
          <div className="flex flex-col">
            <span className="text-[13px] font-medium">{t('updater.progress.title')}</span>
            <span className="text-[11px] text-fog">{phaseLabel}</span>
          </div>
        </div>

        <div
          ref={logRef}
          className="flex-1 min-h-0 overflow-y-auto rounded-[var(--radius-md)] bg-slate border border-charcoal/60 p-2 text-[10px] font-mono text-steel leading-snug whitespace-pre-wrap break-all"
        >
          {logLines.length === 0 ? (
            <span className="text-fog">{t('updater.progress.preparing')}</span>
          ) : (
            logLines.map((line, idx) => <div key={idx}>{line}</div>)
          )}
        </div>

        {isError && errorMessage && (
          <div className="rounded-[var(--radius-md)] bg-pitch border border-rose/40 p-2 text-[11px] text-rose leading-relaxed max-h-20 overflow-y-auto whitespace-pre-wrap break-all">
            {errorMessage}
          </div>
        )}

        {isSuccess && (
          <div className="rounded-[var(--radius-md)] bg-pitch border border-emerald/40 p-2 text-[11px] text-emerald leading-relaxed">
            {t('updater.progress.successHint')}
          </div>
        )}

        <div className="flex justify-end gap-2">
          {isError ? (
            <>
              <Button variant="ghost" onClick={() => window.api.upgrade.cancel()}>
                {t('updater.progress.close')}
              </Button>
              <Button variant="primary" onClick={() => window.api.upgrade.openReleases()}>
                {t('updater.progress.openReleases')}
              </Button>
            </>
          ) : isSuccess ? (
            <>
              <Button variant="ghost" onClick={() => window.api.upgrade.cancel()}>
                {t('updater.progress.restartLater')}
              </Button>
              <Button variant="primary" onClick={() => window.api.upgrade.restart()}>
                {t('updater.progress.restartNow')}
              </Button>
            </>
          ) : (
            <span className="text-[11px] text-fog self-center">
              {phase === 'install'
                ? t('updater.progress.installingHint')
                : t('updater.progress.downloadingHint')}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
