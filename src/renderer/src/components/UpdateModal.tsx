import { useTranslation } from 'react-i18next'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { sanitizeReleaseNotes } from '../utils/sanitizeHtml'

type UpdateInfo = {
  version: string
  releaseNotes: string | null
  releaseDate: string
  installMethod?: 'brew' | 'manual'
}

export function UpdateModal({
  open,
  onOpenChange,
  updateInfo,
  onInstall
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  updateInfo: UpdateInfo | null
  onInstall: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (!updateInfo) return null

  const isBrew = updateInfo.installMethod === 'brew'

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

        {typeof updateInfo.releaseNotes === 'string' && updateInfo.releaseNotes.length > 0 && (
          <div
            className="max-h-40 overflow-y-auto rounded-[var(--radius-md)] bg-pitch border border-charcoal/60 p-3 text-[12px] text-steel leading-relaxed [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:my-1 [&_li]:my-0.5 [&_a]:text-accent [&_a]:underline"
            onClick={(e) => {
              const target = (e.target as HTMLElement).closest('a')
              if (!target) return
              e.preventDefault()
              const href = target.getAttribute('href')
              if (href && /^https?:\/\//.test(href)) window.open(href, '_blank', 'noopener')
            }}
            dangerouslySetInnerHTML={{
              __html: sanitizeReleaseNotes(updateInfo.releaseNotes)
            }}
          />
        )}

        <div className="rounded-[var(--radius-md)] bg-pitch border border-charcoal/60 p-3 text-[11px] text-fog leading-relaxed">
          {isBrew ? t('updater.brewHint') : t('updater.manualHint')}
        </div>

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
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('updater.later')}
            </Button>
            <Button variant="primary" onClick={onInstall}>
              {isBrew ? t('updater.upgradeBrew') : t('updater.openDownload')}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
