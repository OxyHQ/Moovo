import type { ReactNode } from 'react';
import { View, ScrollView } from 'react-native';
import { useTranslation } from '../../hooks/useTranslation';
import { GeneralSection } from '../../components/settings/general-section';
import { SettingsHeader } from '../../components/settings/settings-header';

interface SettingsGeneralScreenProps {
  showBack?: boolean;
  /** The app's language row, which differs per app. */
  languageSelector: ReactNode;
}

export function SettingsGeneralScreen({
  showBack = false,
  languageSelector,
}: SettingsGeneralScreenProps) {
  const { t } = useTranslation();

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t('settings.sections.general')} showBack={showBack} />
      <ScrollView className="flex-1" contentContainerClassName="p-5 max-w-2xl">
        <GeneralSection languageSelector={languageSelector} />
      </ScrollView>
    </View>
  );
}
