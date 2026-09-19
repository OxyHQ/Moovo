import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { useTranslation } from '@/hooks/useTranslation';
import { ChevronDown, Globe2 } from 'lucide-react-native';
import { useOxy } from '@oxy.so/services';
import { getNativeLanguageName } from '@oxy.so/core';

/**
 * The app's UI language is an Oxy-account concern, not Moovo's: Oxy already
 * resolves it (account locales when signed in, a device/guest locale
 * otherwise) and ships the picker that reads and writes it
 * (`LanguageSelectorScreen`, opened here the same way every other Oxy-owned
 * surface is — `showBottomSheet('LanguageSelector')`, exactly like
 * `ManageAccount` elsewhere in Settings). This row just reflects the
 * Oxy-resolved language and opens that sheet.
 */
export function LanguageSelector() {
  const { t } = useTranslation();
  const { showBottomSheet, currentLanguage, currentLanguages } = useOxy();

  // Account locales when there are any (signed in, or a guest override was
  // set), else the single resolved device/fallback locale.
  const selectedLanguages = currentLanguages.length > 0 ? currentLanguages : [currentLanguage];
  const languageDescription = selectedLanguages.map((code) => getNativeLanguageName(code)).join(', ');

  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-2">
        <Globe2 size={20} className="text-primary" />
        <Text className="text-base font-semibold">{t('settings.appLanguage.title')}</Text>
      </View>
      <Text className="text-sm text-muted-foreground">
        {t('settings.appLanguage.description')}
      </Text>
      <Pressable
        onPress={() => showBottomSheet?.('LanguageSelector')}
        className="border border-border rounded-lg px-4 py-3 bg-background flex-row items-center justify-between"
      >
        <Text className="text-foreground">{languageDescription}</Text>
        <ChevronDown size={20} className="text-muted-foreground" />
      </Pressable>
    </View>
  );
}
