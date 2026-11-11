import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { getNativeLanguageName } from '@oxy.so/core';
import { useOxy, useAccountColorSave } from '@oxy.so/services/ui/client';
import { Field } from '@oxy.so/bloom/field';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { PageHeader } from '@oxy.so/bloom/page-header';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { SettingsSelect } from '@oxy.so/bloom/settings-modal/rows';
import { COLOR_PRESET_REGISTRY, useBloomTheme, type ThemeMode } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { useTranslation } from '../../hooks/useTranslation';

const MODES = ['light', 'system', 'dark'] as const;

/**
 * General settings: the Oxy-owned language picker, the appearance mode and the
 * accent colour. Language and accent are Oxy-account concerns, so this screen
 * only reflects them and opens Oxy's own pickers.
 */
export function SettingsGeneralScreen({ showBack = false }: { showBack?: boolean }) {
  const router = useRouter();
  const { t } = useTranslation();
  const { mode, setMode } = useBloomTheme();
  const { showBottomSheet, currentLanguage, currentLanguages } = useOxy();
  const { colors: allowedColors, value: colorValue, saveColor } = useAccountColorSave();

  const languages = (currentLanguages.length > 0 ? currentLanguages : [currentLanguage])
    .map((code) => getNativeLanguageName(code))
    .join(', ');
  const accents = COLOR_PRESET_REGISTRY.filter(({ name }) => allowedColors.includes(name)).map(
    ({ name, displayName }) => ({ value: name, label: displayName }),
  );

  return (
    <View className="flex-1 bg-background">
      <PageHeader
        presentation="bar"
        title={t('settings.sections.general')}
        onBack={showBack ? () => router.back() : null}
      />
      <ScrollView className="flex-1" contentContainerClassName="max-w-2xl gap-6 p-5">
        <GroupedSection>
          <GroupedSectionItem
            title={t('settings.appLanguage.title')}
            description={t('settings.appLanguage.description')}
            value={languages}
            onPress={() => showBottomSheet?.('LanguageSelector')}
          />
        </GroupedSection>

        <Field label={t('settings.appearance.title')}>
          <SegmentedControl
            label={t('settings.appearance.title')}
            type="radio"
            value={mode === 'adaptive' ? 'system' : mode}
            onValueChange={(next) => setMode(next as ThemeMode)}
          >
            {MODES.map((value) => (
              <SegmentedControlItem key={value} value={value}>
                <SegmentedControlItemText>
                  {t(`settings.appearance.${value}`)}
                </SegmentedControlItemText>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </Field>

        <SettingsSelect
          label={t('settings.accentColor.title')}
          value={colorValue}
          onChange={(next) =>
            saveColor(next).catch(() => toast.error(t('settings.accentColor.saveFailed')))
          }
          items={accents}
          compact={false}
        />
      </ScrollView>
    </View>
  );
}
