import { useTranslation } from 'react-i18next'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'

type UpdateInfo = {
  version: string
  releaseNotes: string | null
  releaseDate: string
}

type DownloadProgress = {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
}

export function UpdateModal({
  open,
  onOpenChange,
  updateInfo,
  downloadProgress,
  downloaded,
  onDownload,
  onInstall
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  updateInfo: UpdateInfo | null
  downloadProgress: DownloadProgress | null
  downloaded: boolean
  onDownload: () => void
  onInstall: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (!updateInfo) return null

  const downloading = downloadProgress !== null && !downloaded

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  function formatSpeed(bytesPerSecond: number): string {
    return `${formatBytes(bytesPerSecond)}/s`
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('updater.title')} width="420px">
      <div className="space-y-4">
        <div className="flex items-center gap-3 rounded-[var(--radius-md)] bg-slate p-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-[var(--radius-md)] bg-[color-mix(in_srgb,var(--c-emerald)_15%,transparent)]">
            <span className="i-ph-arrow-circle-up-bold text-emerald text-lg" />
          </div>
          <div className="flex-1 flex items-center justify-between">
            <div className="flex flex-col gap-0.5">
              <span className="text-[13px] text-porcelain font-medium">v{updateInfo.version}</span>
              {updateInfo.releaseDate && (
                <span className="text-[11px] text-fog">
                  {new Date(updateInfo.releaseDate).toLocaleDateString()}
                </span>
              )}
            </div>
            <span className="text-[11px] text-fog">
              {t('updater.current')}: v{window.api.appVersion}
            </span>
          </div>
        </div>

        {updateInfo.releaseNotes && (
          <div
            className="max-h-40 overflow-y-auto rounded-[var(--radius-md)] bg-pitch border border-charcoal/60 p-3 text-[12px] text-steel leading-relaxed [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:my-1 [&_li]:my-0.5 [&_a]:text-accent [&_a]:underline"
            dangerouslySetInnerHTML={{
              __html: typeof updateInfo.releaseNotes === 'string' ? updateInfo.releaseNotes : ''
            }}
          />
        )}

        {downloading && downloadProgress && (
          <div className="space-y-2 rounded-[var(--radius-md)] bg-slate p-3">
            <div className="flex items-center justify-between text-[11px] text-storm mb-1.5">
              <span>
                {formatBytes(downloadProgress.transferred)} / {formatBytes(downloadProgress.total)}
              </span>
              <span>{formatSpeed(downloadProgress.bytesPerSecond)}</span>
            </div>
            <div className="h-1.5 rounded-full bg-charcoal overflow-hidden">
              <div
                className="h-full rounded-full bg-emerald transition-[width] duration-300"
                style={{ width: `${downloadProgress.percent}%` }}
              />
            </div>
            <div className="text-[11px] text-fog text-right">
              {Math.round(downloadProgress.percent)}%
            </div>
          </div>
        )}

        {downloaded && (
          <div className="flex items-center gap-2 rounded-[var(--radius-md)] bg-[color-mix(in_srgb,var(--c-emerald)_10%,transparent)] border border-[color-mix(in_srgb,var(--c-emerald)_20%,transparent)] p-3">
            <span className="i-ph-check-circle-bold text-emerald text-base" />
            <span className="text-[12px] text-emerald font-medium">
              {t('updater.downloadComplete')}
            </span>
          </div>
        )}

        <div className="flex items-center justify-between pt-1">
          <a
            href="https://github.com/bee1an/GatewayHub/releases"
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-fog hover:text-storm transition-colors"
          >
            GitHub Releases
            <span className="i-ph-arrow-square-out ml-0.5 text-[10px] inline-block align-middle" />
          </a>
          <div className="flex gap-2">
            {!downloading && !downloaded && (
              <>
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  {t('updater.later')}
                </Button>
                <Button variant="primary" onClick={onDownload}>
                  {t('updater.download')}
                </Button>
              </>
            )}
            {downloading && (
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t('updater.later')}
              </Button>
            )}
            {downloaded && (
              <>
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  {t('updater.laterRestart')}
                </Button>
                <Button variant="primary" onClick={onInstall}>
                  {t('updater.restart')}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}
