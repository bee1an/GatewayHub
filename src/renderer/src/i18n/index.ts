import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './en'
import zh from './zh'

const savedLang = localStorage.getItem('gatewayhub-lang')
const browserLang = navigator.language.startsWith('zh') ? 'zh' : 'en'

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    zh: { translation: zh },
  },
  lng: savedLang || browserLang,
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
})

export function changeLanguage(lang: string): void {
  i18n.changeLanguage(lang)
  localStorage.setItem('gatewayhub-lang', lang)
}

export default i18n
