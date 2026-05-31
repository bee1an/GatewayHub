import { useMemo, useState } from 'react'
import {
  FALLBACK_CLASSES,
  LOCAL_PROVIDER_LOGOS,
  getLogoDevUrl,
  getProviderLogoInitials,
  getProviderLogoLabel,
  type ProviderLogoTheme
} from './providerLogoData'

type ProviderLogoSize = 'xs' | 'sm' | 'md'

type ProviderLogoProps = {
  providerType: string
  label?: string
  theme: ProviderLogoTheme
  size?: ProviderLogoSize
  className?: string
}

const SIZE_CLASSES: Record<ProviderLogoSize, { wrap: string; image: string; text: string }> = {
  xs: { wrap: 'w-3.5 h-3.5 rounded-[3px]', image: 'w-3.5 h-3.5', text: 'text-[8px]' },
  sm: { wrap: 'w-4 h-4 rounded-[4px]', image: 'w-4 h-4', text: 'text-[9px]' },
  md: { wrap: 'w-7 h-7 rounded-[7px]', image: 'w-7 h-7', text: 'text-[13px]' }
}

export function ProviderLogo({
  providerType,
  label,
  theme,
  size = 'sm',
  className = ''
}: ProviderLogoProps): React.JSX.Element {
  const displayLabel = getProviderLogoLabel(providerType, label)
  const src = useMemo(() => {
    const logoSet = LOCAL_PROVIDER_LOGOS[providerType]
    return logoSet?.[theme] || getLogoDevUrl(providerType, theme)
  }, [providerType, theme])
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const sizeClass = SIZE_CLASSES[size]
  const shouldUseImage = Boolean(src && failedSrc !== src)

  return (
    <span
      className={`inline-flex items-center justify-center shrink-0 overflow-hidden border border-charcoal/45 bg-charcoal/40 shadow-[0_0_0_1px_rgba(255,255,255,0.03)_inset] ${sizeClass.wrap} ${className}`}
      title={displayLabel}
    >
      {shouldUseImage ? (
        <img
          src={src}
          alt={displayLabel}
          draggable={false}
          referrerPolicy="origin"
          className={`${sizeClass.image} object-contain`}
          onError={() => setFailedSrc(src ?? null)}
        />
      ) : (
        <span
          className={`flex h-full w-full items-center justify-center font-[650] leading-none ${sizeClass.text} ${FALLBACK_CLASSES[providerType] || 'bg-charcoal text-porcelain'}`}
          aria-label={displayLabel}
        >
          {getProviderLogoInitials(displayLabel)}
        </span>
      )}
    </span>
  )
}
