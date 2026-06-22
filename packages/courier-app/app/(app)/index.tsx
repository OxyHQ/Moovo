import { View, ScrollView, Platform, ActivityIndicator } from "react-native";
import Head from "expo-router/head";
import { type ReactNode } from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useOxy, showSignInModal } from "@oxyhq/services";
import { FAIR_SYMBOL } from "@moovo/shared-types";
import type { JobSummary } from "@moovo/shared-types";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { MoovoWordmark } from "@/components/ui/moovo-wordmark";
import { useColorScheme } from "@/lib/useColorScheme";
import { queryKeys } from "@/lib/hooks/query-keys";
import { fetchCourierMe, goOnline, goOffline } from "@/lib/api/courier";
import { fetchCourierJobs } from "@/lib/api/jobs";

/** Spread (px) of the gutter-color mask around the rounded frame. Paints a ring
 *  of the gutter color over any content bleeding into the thin gutter + corners. */
const GUTTER_MASK_SPREAD = 40;

/** Neutral, centered loading state shown while cold-boot auth is undetermined. */
function HomeLoading() {
  const { colors } = useColorScheme();
  return (
    <View className="min-h-[480px] items-center justify-center gap-4 px-8 py-24">
      <MoovoWordmark width={140} />
      <ActivityIndicator color={colors.mutedForeground} />
    </View>
  );
}

/** Branded sign-in prompt shown once auth is resolved and the courier is out. */
function SignedOutPrompt() {
  return (
    <View className="min-h-[480px] items-center justify-center gap-6 px-8 py-24">
      <MoovoWordmark width={160} />
      <Text className="max-w-sm text-center text-base text-muted-foreground">
        Go online, accept jobs, get paid. Sign in to start driving.
      </Text>
      <Button onPress={() => showSignInModal()} size="lg">
        <Text className="text-base font-semibold text-primary-foreground">
          Sign in
        </Text>
      </Button>
    </View>
  );
}

/** The availability toggle: reads the courier's `onlineStatus` and flips it. */
function AvailabilityToggle({ canUsePrivateApi }: { canUsePrivateApi: boolean }) {
  const queryClient = useQueryClient();
  const courierQuery = useQuery({
    queryKey: queryKeys.courier.me,
    queryFn: fetchCourierMe,
    enabled: canUsePrivateApi,
  });

  const isOnline = courierQuery.data?.data?.onlineStatus === "online";

  const toggleMutation = useMutation({
    mutationFn: () => (isOnline ? goOffline() : goOnline()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.courier.me });
    },
  });

  const isPending =
    !canUsePrivateApi || courierQuery.isLoading || toggleMutation.isPending;

  return (
    <Card>
      <CardContent className="flex-row items-center justify-between gap-4 pt-5">
        <View className="flex-1 gap-1">
          <Text className="text-lg font-semibold text-surface-foreground">
            {isOnline ? "You're online" : "You're offline"}
          </Text>
          <Text className="text-sm text-muted-foreground">
            {isOnline
              ? "Accepting jobs near you."
              : "Go online to start receiving jobs."}
          </Text>
        </View>
        {isPending ? (
          <ActivityIndicator />
        ) : (
          <Switch
            value={isOnline}
            onValueChange={() => toggleMutation.mutate()}
          />
        )}
      </CardContent>
    </Card>
  );
}

/** A single job row. */
function JobCard({ job }: { job: JobSummary }) {
  const { total } = job.totals;
  // Render the converted display amount + its fiat currency when present, else
  // fall back to the FAIR major amount with the FAIR glyph (never invent fields).
  const totalLabel = total.display
    ? `${total.display.amount} ${total.display.currency}`
    : `${FAIR_SYMBOL}${total.fair}`;

  return (
    <Card>
      <CardContent className="gap-2 pt-5">
        <View className="flex-row items-center justify-between gap-3">
          <Text className="text-base font-semibold text-surface-foreground">
            {job.jobNumber}
          </Text>
          <Text className="text-base font-semibold text-surface-foreground">
            {totalLabel}
          </Text>
        </View>
        <View className="flex-row items-center gap-2">
          <Text className="text-sm capitalize text-muted-foreground">
            {job.type}
          </Text>
          <Text className="text-sm text-muted-foreground">·</Text>
          <Text className="text-sm capitalize text-muted-foreground">
            {job.status.replace("_", " ")}
          </Text>
        </View>
      </CardContent>
    </Card>
  );
}

/** The courier's assigned-jobs list, with loading / empty / error states. */
function JobsList({ canUsePrivateApi }: { canUsePrivateApi: boolean }) {
  const jobsQuery = useQuery({
    queryKey: queryKeys.jobs.courier,
    queryFn: () => fetchCourierJobs(),
    enabled: canUsePrivateApi,
  });

  const jobs = jobsQuery.data?.data ?? [];

  let body: ReactNode;
  if (!canUsePrivateApi || jobsQuery.isLoading) {
    body = (
      <View className="items-center py-10">
        <ActivityIndicator />
      </View>
    );
  } else if (jobsQuery.isError) {
    body = (
      <Text className="py-10 text-center text-sm text-muted-foreground">
        {jobsQuery.error instanceof Error
          ? jobsQuery.error.message
          : "Could not load jobs"}
      </Text>
    );
  } else if (jobs.length === 0) {
    body = (
      <Text className="py-10 text-center text-sm text-muted-foreground">
        No jobs yet
      </Text>
    );
  } else {
    body = (
      <View className="gap-3">
        {jobs.map((job) => (
          <JobCard key={job.id} job={job} />
        ))}
      </View>
    );
  }

  return (
    <View className="gap-3">
      <Text className="text-lg font-semibold text-foreground">Your jobs</Text>
      {body}
    </View>
  );
}

/** A visually-disabled "Coming soon" placeholder card (no logic). */
function ComingSoonCard({ title }: { title: string }) {
  return (
    <Card className="flex-1 opacity-50">
      <CardContent className="items-center gap-1 py-8">
        <Text className="text-base font-semibold text-surface-foreground">
          {title}
        </Text>
        <Text className="text-xs text-muted-foreground">Coming soon</Text>
      </CardContent>
    </Card>
  );
}

/**
 * The courier home. Gates on Oxy cold-boot auth: a neutral loading state while
 * auth is undetermined, a branded sign-in prompt when resolved-and-signed-out,
 * and the online/offline toggle + assigned-jobs list when signed in.
 */
function HomeBody() {
  const { isAuthenticated, isAuthResolved, canUsePrivateApi } = useOxy();

  // Cold-boot auth is still undetermined — neutral loading, never a sign-in flash.
  if (!isAuthResolved) {
    return <HomeLoading />;
  }
  // Resolved and signed out — branded prompt.
  if (!isAuthenticated) {
    return <SignedOutPrompt />;
  }
  // Signed in — the courier "on the road" surface.
  return (
    <View className="gap-6 px-4 py-8 md:px-8">
      <AvailabilityToggle canUsePrivateApi={canUsePrivateApi} />
      <JobsList canUsePrivateApi={canUsePrivateApi} />
      <View className="flex-row gap-3">
        <ComingSoonCard title="Map" />
        <ComingSoonCard title="Scan QR" />
      </View>
    </View>
  );
}

export default function HomeScreen() {
  const { colors } = useColorScheme();
  const isWeb = Platform.OS === "web";

  const head = (
    <Head>
      <title>Moovo Go</title>
      <meta name="description" content="Moovo Go — the courier app. Go online, accept jobs, get paid." />
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
