import { I18n } from 'i18n-js';
import { getLocales } from 'expo-localization';

/**
 * The one i18n-js instance every Moovo app shares. Its device-locale and
 * fallback behaviour live here; an app registers only its own catalogs, with
 * `registerCatalogs` from its `lib/i18n/index.ts`.
 */
const i18n = new I18n();

/**
 * Get the device's current locale
 * Returns full locale code (e.g., "en-US") or falls back to language code (e.g., "en")
 */
function getDeviceLocale(): string {
  const locales = getLocales();
  if (!locales || locales.length === 0) {
    return 'en-US';
  }

  // Try to use full locale code (e.g., "en-US")
  const fullLocale = locales[0]?.languageTag;
  if (fullLocale) {
    return fullLocale;
  }

  // Fallback to language code (e.g., "en")
  return locales[0]?.languageCode ?? 'en-US';
}

// Set the locale from device settings
i18n.locale = getDeviceLocale();

// Enable fallback to base language if specific regional variant is missing
// e.g., if es-MX is not found, it will try 'es', then 'en'
i18n.enableFallback = true;
i18n.missingBehavior = 'guess';

// Default locale
i18n.defaultLocale = 'en-US';

/** Registers an app's English and Spanish catalogs under every regional tag they back. */
export function registerCatalogs(catalogs: { en: object; es: object }): void {
  i18n.store({
    en: catalogs.en,
    'en-US': catalogs.en,
    'en-GB': catalogs.en,
    'en-CA': catalogs.en,
    es: catalogs.es,
    'es-ES': catalogs.es,
    'es-MX': catalogs.es,
    'es-AR': catalogs.es,
  });
}

export default i18n;
