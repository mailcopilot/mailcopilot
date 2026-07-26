import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import en from './locales/en.json'
import ru from './locales/ru.json'
import fr from './locales/fr.json'
import de from './locales/de.json'
import es from './locales/es.json'
import it from './locales/it.json'

export const SUPPORTED_LANGUAGES = ['en', 'ru', 'fr', 'de', 'es', 'it'] as const
export type Language = typeof SUPPORTED_LANGUAGES[number]

export const DEFAULT_LANGUAGE: Language = 'en'

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      ru: { translation: ru },
      fr: { translation: fr },
      de: { translation: de },
      es: { translation: es },
      it: { translation: it },
    },
    lng: DEFAULT_LANGUAGE,
    fallbackLng: DEFAULT_LANGUAGE,
    interpolation: { escapeValue: false },
  })

export default i18n
