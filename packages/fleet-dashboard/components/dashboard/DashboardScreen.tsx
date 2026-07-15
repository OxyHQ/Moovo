import type { ReactNode } from "react";
import { View, ScrollView, Platform, ActivityIndicator } from "react-native";
import Head from "expo-router/head";
import { useOxy, openAccountDialog } from "@oxyhq/services";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { MoovoWordmark } from "@/components/ui/moovo-wordmark";
import { useColorScheme } from "@/lib/useColorScheme";
import { useTranslation } from "@/hooks/useTranslation";

/** Spread (px) of the gutter-color mask around the rounded desktop frame. */
const GUTTER_MASK_SPREAD = 40;

interface DashboardScreenProps {
  /** Document <title> for web. */
  title: string;
  /** Page content (already padded by the caller as needed). */
  children: ReactNode;
  /**
   * When false, the auth/session gate is skipped and `children` render directly
   * (the screen handles its own gating). Defaults to true.
   */
  gate?: boolean;
}

/**
 * Shared dashboard page chrome.
 *
 * Replicates the home screen's responsive frame (desktop rounded panel + bleed
 * mask, body scroll on web, full-height ScrollView on native) and the Oxy
 * auth/session gate (neutral loader while undetermined, branded sign-in prompt
 * when signed out) so every company-scoped screen shares one consistent shell.
 */
export function DashboardScreen({
  title,
  children,
  gate = true,
}: DashboardScreenProps) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const { isAuthenticated, isAuthResolved } = useOxy();
  const isWeb = Platform.OS === "web";

  let body: ReactNode = children;

  if (gate && !isAuthResolved) {
    body = (
      <View className="min-h-[60vh] items-center justify-center px-8 py-24">
        <ActivityIndicator />
      </View>
    );
  } else if (gate && !isAuthenticated) {
    body = (
      <View className="min-h-[60vh] items-center justify-center gap-4 px-8 py-24">
        <MoovoWordmark width={180} />
        <Text className="text-center text-xl font-semibold text-foreground">
          {t("companies.signInTitle")}
        </Text>
        <Text className="max-w-md text-center text-base text-muted-foreground">
          {t("companies.signInSubtitle")}
        </Text>
        <Button onPress={() => openAccountDialog()} className="mt-2">
          <Text className="text-sm font-medium text-primary-foreground">
            {t("companies.signInButton")}
          </Text>
        </Button>
      </View>
    );
  }

  const head = (
    <Head>
      <title>{title}</title>
    </Head>
  );

  if (isWeb) {
    return (
      <>
        {head}
        <View
          pointerEvents="none"
          className="max-md:hidden web:sticky web:top-2 z-30 h-[calc(100dvh-16px)] w-full rounded-3xl border border-border web:[margin-bottom:calc(-100dvh+16px)] web:[clip-path:inset(-12px)]"
          style={{
            boxShadow: `0 0 0 ${GUTTER_MASK_SPREAD}px ${colors.background}`,
          }}
        />
        <View className="relative w-full bg-card pb-24 web:min-h-screen web:overflow-x-clip md:rounded-3xl">
          <View className="web:mx-auto web:w-full web:max-w-[2000px]">
            {body}
          </View>
        </View>
      </>
    );
  }

  return (
    <View className="flex-1 bg-card">
      {head}
      <ScrollView
        className="flex-1 bg-card"
        contentContainerClassName="pb-24"
        keyboardShouldPersistTaps="handled"
      >
        {body}
      </ScrollView>
    </View>
  );
}
