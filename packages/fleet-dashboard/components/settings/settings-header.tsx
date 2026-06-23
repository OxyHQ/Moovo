import { View, useWindowDimensions } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useNavigation } from "expo-router";
import { useRouter } from "expo-router";
import { Menu, ArrowLeft } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

interface SettingsHeaderProps {
  title: string;
  subtitle?: string;
  showBack?: boolean;
  onBack?: () => void;
}

/** A navigator that may (legacy drawer) or may not expose `toggleDrawer`. */
interface MaybeDrawerNavigation {
  toggleDrawer?: () => void;
}

export function SettingsHeader({ title, subtitle, showBack = false, onBack }: SettingsHeaderProps) {
  const navigation = useNavigation<MaybeDrawerNavigation>();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const isLargeScreen = width >= 768;
  const insets = useSafeAreaInsets();

  // The Moovo Hub shell is a Stack navigator with NO drawer, so `toggleDrawer`
  // is absent here; only render the menu button when a drawer actually exists
  // (guards against a runtime crash from calling a missing method).
  const hasDrawer = typeof navigation.toggleDrawer === "function";

  const handleBack = () => {
    if (onBack) {
      onBack();
    } else {
      router.back();
    }
  };

  return (
    <View className="flex-row items-center gap-2 px-4 border-b border-border" style={{ paddingTop: insets.top, height: 56 + insets.top }}>
      {!isLargeScreen && hasDrawer && (
        <Button
          variant="ghost"
          size="icon"
          onPress={() => navigation.toggleDrawer?.()}
          className="h-9 w-9 rounded-full"
        >
          <Menu size={20} className="text-muted-foreground" />
        </Button>
      )}
      {showBack && (
        <Button
          variant="ghost"
          size="icon"
          onPress={handleBack}
          className="h-9 w-9 rounded-full"
        >
          <ArrowLeft size={20} className="text-muted-foreground" />
        </Button>
      )}
      <View className="flex-1">
        <Text className="text-lg font-bold">{title}</Text>
        {subtitle && (
          <Text className="text-sm text-muted-foreground">{subtitle}</Text>
        )}
      </View>
    </View>
  );
}
