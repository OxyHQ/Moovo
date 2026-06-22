import { View, ScrollView, Platform, ActivityIndicator } from "react-native";
import Head from "expo-router/head";
import { Link } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useOxy, showSignInModal } from "@oxyhq/services";
import type { Company } from "@moovo/shared-types";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MoovoWordmark } from "@/components/ui/moovo-wordmark";
import { useColorScheme } from "@/lib/useColorScheme";
import { useTranslation } from "@/hooks/useTranslation";
import { fetchCompanies } from "@/lib/api/companies";
import { queryKeys } from "@/lib/hooks/query-keys";

/** Spread (px) of the gutter-color mask around the rounded frame. Paints a ring
 *  of the gutter color over any content bleeding into the thin gutter + corners. */
const GUTTER_MASK_SPREAD = 40;

/** Maps a company lifecycle status to its `companies.status.*` i18n key. */
const STATUS_LABEL_KEY: Record<Company["status"], string> = {
  active: "companies.status.active",
  suspended: "companies.status.suspended",
  closed: "companies.status.closed",
};

/** A single company tile in the dashboard grid. */
function CompanyCard({ company }: { company: Company }) {
  const { t } = useTranslation();
  return (
    <Card className="gap-3 p-4">
      <View className="flex-row items-center gap-3">
        {/* Brand accent — `company.brandColor` is a per-row runtime CSS color
            from the API; there is no NativeWind class for an arbitrary color, so
            an inline backgroundColor is the correct tool here. */}
        <View
          className="h-9 w-1.5 rounded-full"
          style={{ backgroundColor: company.brandColor }}
        />
        <View className="min-w-0 flex-1">
          <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
            {company.name}
          </Text>
          <Text className="text-sm text-muted-foreground" numberOfLines={1}>
            {t("companies.membersCount", { count: company.members.length })}
          </Text>
        </View>
      </View>
      <View className="self-start rounded-full bg-muted px-2.5 py-1">
        <Text className="text-xs font-medium text-muted-foreground">
          {t(STATUS_LABEL_KEY[company.status])}
        </Text>
      </View>
    </Card>
  );
}

/**
 * Moovo Hub home: the operator's companies.
 *
 * Auth-gated against the Oxy SDK — while the session is undetermined we show a
 * neutral loader; signed-out users get a branded sign-in prompt; signed-in
 * operators get their companies (fetched only once the private API is ready).
 */
function HomeBody() {
  const { t } = useTranslation();
  const { isAuthenticated, isAuthResolved, canUsePrivateApi } = useOxy();

  const companiesQuery = useQuery({
    queryKey: queryKeys.companies.all,
    queryFn: fetchCompanies,
    enabled: canUsePrivateApi,
  });

  // Session still resolving (cold boot) — neutral loader, never flash signed-out.
  if (!isAuthResolved) {
    return (
      <View className="min-h-[60vh] items-center justify-center px-8 py-24">
        <ActivityIndicator />
      </View>
    );
  }

  // Resolved + signed out — branded sign-in prompt.
  if (!isAuthenticated) {
    return (
      <View className="min-h-[60vh] items-center justify-center gap-4 px-8 py-24">
        <MoovoWordmark width={180} />
        <Text className="text-center text-xl font-semibold text-foreground">
          {t("companies.signInTitle")}
        </Text>
        <Text className="max-w-md text-center text-base text-muted-foreground">
          {t("companies.signInSubtitle")}
        </Text>
        <Button onPress={() => showSignInModal()} className="mt-2">
          <Text className="text-sm font-medium text-primary-foreground">
            {t("companies.signInButton")}
          </Text>
        </Button>
      </View>
    );
  }

  const companies = companiesQuery.data?.data ?? [];

  return (
    <View className="gap-6 px-5 py-8 md:px-8">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="text-2xl font-bold text-foreground">
          {t("companies.heading")}
        </Text>
        <Link href="/companies/new" asChild>
          <Button>
            <Text className="text-sm font-medium text-primary-foreground">
              {t("companies.createCompany")}
            </Text>
          </Button>
        </Link>
      </View>

      {companiesQuery.isPending ? (
        <View className="items-center py-16">
          <ActivityIndicator />
        </View>
      ) : companiesQuery.isError ? (
        <View className="items-center gap-3 py-16">
          <Text className="text-center text-base text-muted-foreground">
            {t("companies.loadError")}
          </Text>
          <Button variant="outline" onPress={() => companiesQuery.refetch()}>
            <Text className="text-sm font-medium text-foreground">
              {t("common.tryAgain")}
            </Text>
          </Button>
        </View>
      ) : companies.length === 0 ? (
        <View className="items-center gap-4 py-16">
          <Text className="text-center text-lg font-semibold text-foreground">
            {t("home.emptyTitle")}
          </Text>
          <Text className="max-w-md text-center text-base text-muted-foreground">
            {t("home.emptySubtitle")}
          </Text>
          <Link href="/companies/new" asChild>
            <Button>
              <Text className="text-sm font-medium text-primary-foreground">
                {t("companies.createCompany")}
              </Text>
            </Button>
          </Link>
        </View>
      ) : (
        <View className="gap-4 md:grid md:grid-cols-2 md:gap-4 lg:grid-cols-3">
          {companies.map((company) => (
            <CompanyCard key={company.id} company={company} />
          ))}
        </View>
      )}
    </View>
  );
}

export default function HomeScreen() {
  const { colors } = useColorScheme();
  const isWeb = Platform.OS === "web";

  const head = (
    <Head>
      <title>Moovo Hub</title>
      <meta
        name="description"
        content="Moovo Hub — manage your delivery fleet, companies, and jobs."
      />
    </Head>
  );

  // WEB: the content flows in normal document flow (no vertical ScrollView) so the
  // BODY scrolls — scrolling works from anywhere, incl. over the sticky rail and
  // gutter (pure NativeWind classes, zero scroll JS).
  if (isWeb) {
    return (
      <>
        {head}
        {/* Decorative rounded-panel frame + bleed mask (desktop only, gated by
            CSS `max-md:hidden` — no JS width check). A STICKY overlay pinned to
            the viewport; the negative bottom margin gives it ~0 layout height so
            it doesn't push the content, while it frames the viewport and stays put
            as the body scrolls under it. The `boxShadow` paints a ring of the
            GUTTER color (Bloom `background` token — not hardcoded) around the
            rounded rect; `clip-path: inset(-12px)` keeps that ring from spilling
            onto the rail. `pointer-events-none` passes clicks. */}
        <View
          pointerEvents="none"
          className="max-md:hidden web:sticky web:top-2 z-30 h-[calc(100dvh-16px)] w-full rounded-3xl border border-border web:[margin-bottom:calc(-100dvh+16px)] web:[clip-path:inset(-12px)]"
          style={{
            boxShadow: `0 0 0 ${GUTTER_MASK_SPREAD}px ${colors.background}`,
          }}
        />
        {/* The content panel flows in the document and scrolls with the body,
            passing under the sticky frame. Full-bleed below md, rounded card panel
            at md+. The content is centered (`mx-auto max-w-[2000px]`). */}
        <View className="relative w-full bg-card pb-24 web:min-h-screen web:overflow-x-clip md:rounded-3xl">
          <View className="web:mx-auto web:w-full web:max-w-[2000px]">
            <HomeBody />
          </View>
        </View>
      </>
    );
  }

  // NATIVE: a single full-height ScrollView (no document scroll on native).
  return (
    <View className="flex-1 bg-card">
      {head}
      <ScrollView
        className="flex-1 bg-card"
        contentContainerClassName="pb-24"
        keyboardShouldPersistTaps="handled"
      >
        <HomeBody />
      </ScrollView>
    </View>
  );
}
