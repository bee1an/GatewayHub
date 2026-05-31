import kiroIcon from '../assets/kiro-icon.svg'
import codexIconDark from '../assets/codex-icon-dark.svg'
import codexIconLight from '../assets/codex-icon-light.svg'
import openRouterIcon from '../assets/provider-logos/openrouter-icon.png'
import windsurfIcon from '../assets/provider-logos/windsurf-icon.svg'
import traeIcon from '../assets/provider-logos/trae-icon.png'
import geminiIcon from '../assets/provider-logos/gemini-icon.svg'
import nvidiaIcon from '../assets/provider-logos/nvidia-icon.png'

export type ProviderLogoTheme = 'light' | 'dark'

type ProviderLogoSet = {
  light: string
  dark: string
}

export const LOCAL_PROVIDER_LOGOS: Record<string, ProviderLogoSet> = {
  kiro: { light: kiroIcon, dark: kiroIcon },
  codex: { light: codexIconLight, dark: codexIconDark },
  windsurf: { light: windsurfIcon, dark: windsurfIcon },
  trae: { light: traeIcon, dark: traeIcon },
  openrouter: { light: openRouterIcon, dark: openRouterIcon },
  nvidia: { light: nvidiaIcon, dark: nvidiaIcon },
  gemini: { light: geminiIcon, dark: geminiIcon }
}

export const LOGO_DEV_DOMAINS: Record<string, string> = {
  kiro: 'kiro.dev',
  codex: 'openai.com',
  windsurf: 'windsurf.com',
  trae: 'trae.ai',
  openrouter: 'openrouter.ai',
  nvidia: 'nvidia.com',
  gemini: 'gemini.google.com'
}

export const FALLBACK_CLASSES: Record<string, string> = {
  kiro: 'bg-[#9046FF] text-white',
  codex: 'bg-porcelain text-pitch',
  windsurf: 'bg-[#0B100F] text-[#F9F3E9]',
  trae: 'bg-[#101828] text-[#2EF58D]',
  openrouter: 'bg-porcelain text-pitch',
  nvidia: 'bg-[#76B900] text-pitch',
  gemini: 'bg-gradient-to-br from-cyan via-aether to-violet text-white'
}

const PROVIDER_LABELS: Record<string, string> = {
  kiro: 'Kiro',
  codex: 'Codex',
  windsurf: 'Windsurf',
  trae: 'Trae',
  openrouter: 'OpenRouter',
  nvidia: 'NVIDIA',
  gemini: 'Gemini'
}

export function getProviderLogoLabel(providerType: string, displayName?: string): string {
  return displayName || PROVIDER_LABELS[providerType] || providerType
}

export function getLogoDevUrl(providerType: string, theme: ProviderLogoTheme): string | undefined {
  const token = import.meta.env.VITE_LOGO_DEV_TOKEN?.trim()
  const domain = LOGO_DEV_DOMAINS[providerType]
  if (!token || !domain) return undefined

  const params = new URLSearchParams({
    token,
    size: '64',
    format: 'png',
    retina: 'true',
    fallback: 'monogram',
    theme
  })

  return `https://img.logo.dev/${domain}?${params.toString()}`
}

export function getProviderLogoInitials(label: string): string {
  const words = label
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0]}${words[1][0]}`.toUpperCase()
}
