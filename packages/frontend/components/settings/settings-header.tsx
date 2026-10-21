import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface SettingsHeaderProps {
  title: string;
  subtitle?: string;
  showBack?: boolean;
  onBack?: () => void;
}

/**
 * Header for the settings screens. There is no menu button: the app shell is a
 * Stack with the bottom tab bar (and the NavRail on wide web) as its navigation,
 * and no drawer exists to open.
 */
export function SettingsHeader({ title, subtitle, showBack = false, onBack }: SettingsHeaderProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const handleBack = () => {
    if (onBack) {
      onBack();
    } else {
      router.back();
    }
  };

  return (
    <View
      className="flex-row items-center gap-2 px-4 border-b border-border"
      style={{ paddingTop: insets.top, height: 56 + insets.top }}
    >
      {showBack && (
        <Button variant="ghost" size="icon" onPress={handleBack} className="h-9 w-9 rounded-full">
          <ArrowLeft size={20} className="text-muted-foreground" />
        </Button>
      )}
      <View className="flex-1">
        <Text className="text-lg font-bold">{title}</Text>
        {subtitle && <Text className="text-sm text-muted-foreground">{subtitle}</Text>}
      </View>
    </View>
  );
}
