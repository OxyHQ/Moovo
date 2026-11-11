import { SettingsGeneralScreen } from '@moovo/app-shell/screens/settings/general';
import { LanguageSelector } from '@/components/language-selector';

export default function GeneralSettingsRoute() {
  return <SettingsGeneralScreen showBack languageSelector={<LanguageSelector />} />;
}
