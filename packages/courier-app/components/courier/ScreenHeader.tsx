import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";

/**
 * A lightweight back-navigation header for the courier stack screens (vehicles,
 * add-vehicle, active job). Unlike the inherited `SettingsHeader` it does NOT
 * depend on a drawer navigator — it is a plain back button + title sized to the
 * top safe-area inset, suitable for `<Stack>` screens on native and web.
 */

/** Fixed header content height (excluding the safe-area inset). */
const HEADER_HEIGHT = 56;

interface ScreenHeaderProps {
  /** Header title. */
  title: string;
  /** Optional secondary line under the title. */
  subtitle?: string;
  /** Optional trailing action slot (rendered at the right edge). */
  right?: React.ReactNode;
}

export function ScreenHeader({ title, subtitle, right }: ScreenHeaderProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useColorScheme();

  return (
    <View
      className="flex-row items-center gap-2 border-b border-border bg-background px-2"
      style={{ paddingTop: insets.top, height: HEADER_HEIGHT + insets.top }}
    >
      <Pressable
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel="Go back"
        className="h-10 w-10 items-center justify-center rounded-full active:bg-accent web:hover:bg-accent"
      >
        <ArrowLeft size={22} color={colors.foreground} />
      </Pressable>
      <View className="flex-1">
        <Text className="text-lg font-bold text-foreground">{title}</Text>
        {subtitle ? (
          <Text className="text-sm text-muted-foreground">{subtitle}</Text>
        ) : null}
      </View>
      {right ? <View className="pr-2">{right}</View> : null}
    </View>
  );
}
