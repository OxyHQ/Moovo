import i18n, { registerCatalogs } from '@moovo/app-shell/lib/i18n';
import en from './locales/en.json';
import es from './locales/es.json';

registerCatalogs({ en, es });

/** This app's own catalog: the exact locales `en.json`/`es.json` back. */
export const DEFAULT_LOCALE = 'en-US';
export const SUPPORTED_LOCALES = ['en-US', 'en-GB', 'es-ES', 'es-MX'] as const;

export default i18n;
