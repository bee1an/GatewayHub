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
    <Modal
      open={open}
      onOpenChange={downloading ? () => {} : onOpenChange}
      title={t('updater.title')}
    >
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald/10 border border-emerald/20 text-emerald font-medium">
            v{updateInfo.version}
          </span>
          {updateInfo.releaseDate && (
            <span className="text-[11px] text-fog">
              {new Date(updateInfo.releaseDate).toLocaleDateString()}
            </span>
          )}
        </div>

        {updateInfo.releaseNotes && (
          <div className="max-h-48 overflow-y-auto rounded-[var(--radius-md)] bg-pitch border border-charcoal/60 p-3">
            <pre className="text-[12px] text-steel whitespace-pre-wrap font-sans leading-relaxed">
              {typeof updateInfo.releaseNotes === 'string' ? updateInfo.releaseNotes : ''}
            </pre>
          </div>
        )}

        {downloading && downloadProgress && (
          <div className="space-y-2">
            <div className="h-2 rounded-full bg-charcoal overflow-hidden">
              <div
                className="h-full rounded-full bg-emerald transition-[width] duration-300"
                style={{ width: `${downloadProgress.percent}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-fog">
              <span>
                {formatBytes(downloadProgress.transferred)} / {formatBytes(downloadProgress.total)}
              </span>
              <span>{formatSpeed(downloadProgress.bytesPerSecond)}</span>
            </div>
            <div className="text-[11px] text-fog text-center">
              {Math.round(downloadProgress.percent)}%
            </div>
          </div>
        )}

        {downloaded && (
          <div className="text-[12px] text-emerald font-medium text-center py-2">
            {t('updater.downloadComplete')}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          {!downloading && !downloaded && (
            <>
              <Button variant="default" onClick={() => onOpenChange(false)}>
                {t('updater.later')}
              </Button>
              <Button variant="primary" onClick={onDownload}>
                {t('updater.download')}
              </Button>
            </>
          )}
          {downloaded && (
            <>
              <Button variant="default" onClick={() => onOpenChange(false)}>
                {t('updater.laterRestart')}
              </Button>
              <Button variant="primary" onClick={onInstall}>
                {t('updater.restart')}
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
