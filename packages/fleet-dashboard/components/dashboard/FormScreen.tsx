import type { ReactNode } from "react";
import { View, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft } from "lucide-react-native";
import Head from "expo-router/head";
import { Text } from "@/components/ui/text";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

/** Header height (px) below the safe-area inset — matches `SettingsHeader`. */
const HEADER_HEIGHT = 56;

interface FormScreenProps {
  title: string;
  children: ReactNode;
}

/**
 * A form page shell: a back-affordance header + a centered, scrollable padded
 * body. Used by the create-company and company-settings forms. Web title is set
 * for the document head.
 */
export function FormScreen({ title, children }: FormScreenProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-background">
      <Head>
        <title>{title} · Moovo Hub</title>
      </Head>
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
          <Text className="text-lg font-bold" numberOfLines={1}>
            {title}
          </Text>
        </View>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerClassName="p-5 pb-24 gap-5 w-full max-w-2xl mx-auto"
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </View>
  );
}

/** A labelled form field wrapper with an optional helper/error line. */
export function Field({
  label,
  helper,
  error,
  children,
}: {
  label: string;
  helper?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <View className="gap-2">
      <Label>{label}</Label>
      {children}
      {error ? (
        <Text className="text-xs text-destructive">{error}</Text>
      ) : helper ? (
        <Text className="text-xs text-muted-foreground">{helper}</Text>
      ) : null}
    </View>
  );
}
