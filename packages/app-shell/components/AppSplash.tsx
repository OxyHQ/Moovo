import { View } from 'react-native';
import { Loading } from '@oxy.so/bloom/loading';
import { useTheme } from '@oxy.so/bloom/theme';
import { Logo } from './Logo';

/** The first paint while Bloom loads its fonts and strings. Rendered inside `BloomProvider`, so it is themed. */
export function AppSplash() {
  const { colors } = useTheme();
  return (
    <View className="flex-1 items-center justify-center gap-8 bg-background">
      <Logo size={96} color={colors.text} />
      <Loading variant="spinner" accessibilityLabel="Loading" />
    </View>
  );
}
