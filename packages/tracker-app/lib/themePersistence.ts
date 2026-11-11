export { BLOOM_THEME_STORAGE } from '@moovo/app-shell/lib/themePersistence';

/**
 * Single source of truth for where Bloom persists the active theme
 * (`{ mode?, colorPreset? }` as JSON). `BloomThemeProvider` writes it and the
 * splash reads it; the key lives here so writers and readers can never drift.
 */
export const BLOOM_THEME_PERSIST_KEY = 'moovotracker.bloom.theme';
