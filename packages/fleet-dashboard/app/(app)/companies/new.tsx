import { View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/hooks/useTranslation";

/** Header height (px) below the safe-area inset — matches `SettingsHeader`. */
const HEADER_HEIGHT = 56;

/**
 * Create company — placeholder screen.
 *
 * Keeps the app shell (back affordance + titled header) so the route is wired
 * end to end, but holds no create logic yet: company creation lands in a later
 * phase of the Moovo Hub fleet domain.
 */
export default function NewCompanyScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-background">
      <View
        className="flex-row items-center gap-2 border-b border-border px-4"
        style={{ paddingTop: insets.top, height: HEADER_HEIGHT + insets.top }}
      >
        <Button
          variant="ghost"
          size="icon"
          onPress={() => router.back()}
          className="h-9 w-9 rounded-full"
        >
          <ArrowLeft size={20} className="text-muted-foreground" />
        </Button>
        <View className="flex-1">
          <Text className="text-lg font-bold">
            {t("companies.comingSoonTitle")}
          </Text>
        </View>
      </View>

      <View className="flex-1 items-center justify-center gap-2 px-8">
        <Text className="text-center text-xl font-semibold text-foreground">
          {t("companies.comingSoonTitle")}
        </Text>
        <Text className="max-w-md text-center text-base text-muted-foreground">
          {t("companies.comingSoonBody")}
        </Text>
      </View>
    </View>
  );
}
