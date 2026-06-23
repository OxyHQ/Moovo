import { type ReactNode } from "react";
import { View, ScrollView, ActivityIndicator, Pressable } from "react-native";
import Head from "expo-router/head";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useOxy, showSignInModal } from "@oxyhq/services";
import type { JobSummary } from "@moovo/shared-types";
import { ChevronRight } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScreenHeader } from "@/components/courier/ScreenHeader";
import { useColorScheme } from "@/lib/useColorScheme";
import { queryKeys } from "@/lib/hooks/query-keys";
import { fetchCourierJobs } from "@/lib/api/jobs";
import { formatDisplayMoney } from "@/lib/money";
import { statusLabel, isTerminal } from "@/lib/job-flow";
import { errorMessage } from "@/lib/api/errors";

/** Format a job's creation date for the card (locale short date). */
function formatJobDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * A single job row — type · size · status pill, fare, date — tapping it opens the
 * job detail screen. Mirrors the home dashboard's job card so the two surfaces
 * stay visually consistent. `JobSummary` is the compact list projection (no
 * address snapshots), so the row shows the job classification rather than the
 * pickup→dropoff route, which only the detail view's `JobView` carries.
 */
function JobCard({ job }: { job: JobSummary }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const fareLabel = formatDisplayMoney(job.totals.total);
  const dateLabel = formatJobDate(job.createdAt);

  return (
    <Pressable
      onPress={() => router.push(`/jobs/${job.id}`)}
      accessibilityRole="button"
      accessibilityLabel={`Open job ${job.jobNumber}`}
    >
      <Card className="active:opacity-90 web:hover:opacity-90">
        <CardContent className="flex-row items-center gap-3 pt-5">
          <View className="flex-1 gap-2">
            <View className="flex-row items-center justify-between gap-3">
              <Text className="text-base font-semibold text-surface-foreground">
                {job.jobNumber}
              </Text>
              <Text className="text-base font-semibold text-surface-foreground">
                {fareLabel}
              </Text>
            </View>
            <View className="flex-row items-center gap-2">
              <Text className="text-sm capitalize text-muted-foreground">
                {job.type}
              </Text>
              <Text className="text-sm text-muted-foreground">·</Text>
              <Text className="text-sm capitalize text-muted-foreground">
                {job.sizeClass}
              </Text>
              {dateLabel ? (
                <>
                  <Text className="text-sm text-muted-foreground">·</Text>
                  <Text className="text-sm text-muted-foreground">
                    {dateLabel}
                  </Text>
                </>
              ) : null}
            </View>
            <View className="flex-row">
              <View className="rounded-full bg-primary/10 px-3 py-1">
                <Text className="text-xs font-semibold text-primary">
                  {statusLabel(job.status)}
                </Text>
              </View>
            </View>
          </View>
          <ChevronRight size={20} color={colors.mutedForeground} />
        </CardContent>
      </Card>
    </Pressable>
  );
}

/** A titled group of job cards (e.g. "Active", "Past"). */
function JobSection({ title, jobs }: { title: string; jobs: JobSummary[] }) {
  if (jobs.length === 0) return null;
  return (
    <View className="gap-3">
      <Text className="text-lg font-semibold text-foreground">{title}</Text>
      <View className="gap-3">
        {jobs.map((job) => (
          <JobCard key={job.id} job={job} />
        ))}
      </View>
    </View>
  );
}

/**
 * The courier's job list: every job they've been assigned (active + history),
 * newest first, grouped into Active (non-terminal) and Past (delivered /
 * cancelled). Gates on Oxy cold-boot auth, then reads `GET /jobs?role=courier`.
 */
function JobsBody() {
  const { isAuthenticated, isAuthResolved, canUsePrivateApi } = useOxy();
  const { colors } = useColorScheme();

  const jobsQuery = useQuery({
    queryKey: queryKeys.jobs.courier,
    queryFn: () => fetchCourierJobs(),
    enabled: canUsePrivateApi,
  });

  if (!isAuthResolved) {
    return (
      <View className="items-center py-24">
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  }
  if (!isAuthenticated) {
    return (
      <View className="items-center gap-4 px-8 py-24">
        <Text className="text-center text-base text-muted-foreground">
          Sign in to see your jobs.
        </Text>
        <Button onPress={() => showSignInModal()}>
          <Text className="font-semibold text-primary-foreground">Sign in</Text>
        </Button>
      </View>
    );
  }

  if (jobsQuery.isLoading || !canUsePrivateApi) {
    return (
      <View className="items-center py-24">
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  }
  if (jobsQuery.isError) {
    return (
      <Text className="px-8 py-24 text-center text-sm text-muted-foreground">
        {errorMessage(jobsQuery.error, "Could not load your jobs")}
      </Text>
    );
  }

  const jobs = jobsQuery.data?.data ?? [];
  if (jobs.length === 0) {
    return (
      <View className="items-center gap-2 px-8 py-24">
        <Text className="text-base font-semibold text-surface-foreground">
          No jobs yet
        </Text>
        <Text className="text-center text-sm text-muted-foreground">
          Go online from Home to start receiving jobs.
        </Text>
      </View>
    );
  }

  const active = jobs.filter((job) => !isTerminal(job.status));
  const past = jobs.filter((job) => isTerminal(job.status));

  let body: ReactNode;
  if (active.length === 0 && past.length > 0) {
    // History-only — show the past list without an empty "Active" header.
    body = <JobSection title="Past" jobs={past} />;
  } else {
    body = (
      <>
        <JobSection title="Active" jobs={active} />
        <JobSection title="Past" jobs={past} />
      </>
    );
  }

  return <View className="gap-6 p-4">{body}</View>;
}

export default function JobsScreen() {
  return (
    <View className="flex-1 bg-background">
      <Head>
        <title>Jobs · Moovo Go</title>
      </Head>
      <ScreenHeader title="Jobs" subtitle="Your active jobs and history" />
      <ScrollView
        className="flex-1"
        contentContainerClassName="pb-24 mx-auto w-full max-w-2xl"
      >
        <JobsBody />
      </ScrollView>
    </View>
  );
}
