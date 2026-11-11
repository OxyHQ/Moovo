import { View } from 'react-native';
import { Text } from '@oxy.so/bloom/typography';
import { Logo } from '@moovo/app-shell/components/Logo';

export function Footer() {
  return (
    <View className="mt-8 gap-3 border-t border-border px-6 py-8">
      <View className="flex-row items-center gap-2">
        <Logo size={20} />
        <Text variant="body-semibold">Moovo</Text>
      </View>
      <Text variant="caption-1-regular" className="text-muted-foreground">
        © {new Date().getFullYear()} Moovo by Oxy
      </Text>
    </View>
  );
}
