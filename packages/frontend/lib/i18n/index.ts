import i18n, { registerCatalogs } from '@moovo/app-shell/lib/i18n';
import en from './locales/en.json';
import es from './locales/es.json';

registerCatalogs({ en, es });

export default i18n;
