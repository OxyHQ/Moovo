import { useMemo } from "react";
import { View, ActivityIndicator } from "react-native";
import { Link } from "expo-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Info, Wifi, WifiOff } from "lucide-react-native";
import type { JobSummary, JobView } from "@moovo/shared-types";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DashboardScreen } from "@/components/dashboard/DashboardScreen";
import {
  CompanyHeader,
  NoCompaniesState,
  PermissionDenied,
} from "@/components/dashboard/CompanyHeader";
import { StatusChip } from "@/components/dashboard/StatusChip";
import { FleetMap } from "@/components/dashboard/Map";
import type { MapMarker } from "@/components/dashboard/map-types";
import { fetchJobs, fetchJob } from "@/lib/api/jobs";
import { queryKeys } from "@/lib/hooks/query-keys";
import { useCompanyContext } from "@/lib/hooks/use-company-context";
import { useJobSocket } from "@/lib/hooks/use-job-socket";
import { useColorScheme } from "@/lib/useColorScheme";
import { useTranslation } from "@/hooks/useTranslation";
import { formatMoney, formatTime, isActiveJob, jobTypeKey } from "@/lib/format";
import { useI18nStore } from "@/lib/stores/i18n-store";

/** Max active jobs we fetch full detail for (to plot pickups on the map). */
const MAX_DETAIL_FETCH = 20;

/** One dispatch row: job number, route cities, value, status. */
function DispatchRow({ job, detail }: { job: JobSummary; detail?: JobView }) {
  const { t } = useTranslation();
  const locale = useI18nStore((s) => s.locale);
  const route = detail
    ? `${detail.pickupSnapshot.address.city} → ${detail.dropoffSnapshot.address.city}`
    : t(jobTypeKey(job.type));

  return (
    <Link href={{ pathname: "/jobs/[id]", params: { id: job.id } }} asChild>
      <View className="flex-row items-center gap-3 border-b border-border py-3 web:cursor-pointer web:hover:bg-accent/40">
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-semibold text-surface-foreground" numberOfLines={1}>
            {job.jobNumber}
          </Text>
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {route} · {formatTime(job.createdAt, locale)}
          </Text>
        </View>
        <Text className="text-sm font-medium text-surface-foreground">
          {formatMoney(job.totals.total)}
        </Text>
        <StatusChip status={job.status} />
      </View>
    </Link>
  );
}

/** The "connected" indicator for the live socket. */
function LiveIndicator({ connected }: { connected: boolean }) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  return (
    <View className="flex-row items-center gap-1.5">
      {connected ? (
        <Wifi size={14} color={colors.primary} />
      ) : (
        <WifiOff size={14} color={colors.mutedForeground} />
      )}
      <Text
        className={
          connected
            ? "text-xs font-medium text-primary"
            : "text-xs text-muted-foreground"
        }
      >
        {connected ? t("dispatch.live") : t("dispatch.offline")}
      </Text>
    </View>
  );
}

function DispatchBody() {
  const { t } = useTranslation();
  const ctx = useCompanyContext();
  const { colors } = useColorScheme();

  const companyId = ctx.selectedCompanyId;
  const canRead = ctx.can("jobs:read");
  const enabled = ctx.canUsePrivateApi && companyId !== null && canRead;

  const socket = useJobSocket(enabled);

  const jobsQuery = useQuery({
    queryKey: queryKeys.jobs.list("sender"),
    queryFn: () => fetchJobs({ role: "sender", limit: 50 }),
    enabled,
  });

  const jobs = jobsQuery.data?.data ?? [];
  const activeJobs = useMemo(
    () => jobs.filter((j) => isActiveJob(j.status)),
    [jobs],
  );

  // Fetch full detail for active jobs so pickups/dropoffs can be mapped.
  const detailQueries = useQueries({
    queries: activeJobs.slice(0, MAX_DETAIL_FETCH).map((job) => ({
      queryKey: ["jobs", "detail", job.id],
      queryFn: () => fetchJob(job.id),
      enabled,
      staleTime: 30 * 1000,
    })),
  });

  const detailById = useMemo(() => {
    const map = new Map<string, JobView>();
    for (const q of detailQueries) {
      if (q.data) map.set(q.data.id, q.data);
    }
    return map;
  }, [detailQueries]);

  // Map markers: pickups/dropoffs from job detail + live courier positions.
  const markers = useMemo<MapMarker[]>(() => {
    const result: MapMarker[] = [];
    for (const job of activeJobs) {
      const detail = detailById.get(job.id);
      if (detail) {
        const [pLng, pLat] = detail.pickupSnapshot.location.coordinates;
        result.push({
          id: `pickup-${job.id}`,
          lng: pLng,
          lat: pLat,
          kind: "pickup",
          label: `${job.jobNumber} · ${detail.pickupSnapshot.address.city}`,
        });
        const [dLng, dLat] = detail.dropoffSnapshot.location.coordinates;
        result.push({
          id: `dropoff-${job.id}`,
          lng: dLng,
          lat: dLat,
          kind: "dropoff",
          label: `${job.jobNumber} · ${detail.dropoffSnapshot.address.city}`,
        });
      }
    }
    // Live courier positions (latest ping per job) overlaid on top.
    for (const live of Object.values(socket.liveLocations)) {
      const [lng, lat] = live.location.coordinates;
      result.push({
        id: `courier-${live.jobId}`,
        lng,
        lat,
        kind: "courier",
        label: t("dispatch.courierHere"),
      });
    }
    return result;
  }, [activeJobs, detailById, socket.liveLocations, t]);

  if (ctx.isLoadingCompanies) {
    return (
      <View className="items-center py-16">
        <ActivityIndicator />
      </View>
    );
  }
  if (ctx.companies.length === 0) return <NoCompaniesState />;

  return (
    <View className="gap-6 px-5 py-8 md:px-8">
      <CompanyHeader
        title={t("nav.dispatch")}
        companies={ctx.companies}
        selectedCompanyId={ctx.selectedCompanyId}
        onSelect={ctx.selectCompany}
        action={<LiveIndicator connected={socket.connected} />}
      />

      {!canRead ? (
        <PermissionDenied message={t("dispatch.readDenied")} />
      ) : (
        <>
          {/* Honest disclosure of the backend scope limitation: the jobs API is
              caller-scoped (sender/courier), with no company-wide jobs feed yet.
              The board therefore shows the operator's own jobs + live socket
              events for jobs they are party to. */}
          <Card className="flex-row items-start gap-3 border-primary/30 bg-primary/5 p-4">
            <Info size={18} color={colors.primary} />
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-semibold text-surface-foreground">
                {t("dispatch.scopeNoticeTitle")}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {t("dispatch.scopeNoticeBody")}
              </Text>
            </View>
          </Card>

          {/* Live map */}
          <FleetMap markers={markers} height={360} />

          {/* Active jobs board */}
          <Card className="p-4">
            <View className="flex-row items-center justify-between pb-1">
              <Text className="text-base font-semibold text-surface-foreground">
                {t("dispatch.activeTitle", { count: activeJobs.length })}
              </Text>
              {jobsQuery.isFetching ? <ActivityIndicator size="small" /> : null}
            </View>
            {jobsQuery.isPending ? (
              <View className="items-center py-10">
                <ActivityIndicator />
              </View>
            ) : jobsQuery.isError ? (
              <View className="items-center gap-3 py-10">
                <Text className="text-center text-sm text-muted-foreground">
                  {t("dispatch.loadError")}
                </Text>
                <Button variant="outline" onPress={() => jobsQuery.refetch()}>
                  <Text className="text-sm font-medium text-foreground">
                    {t("common.tryAgain")}
                  </Text>
                </Button>
              </View>
            ) : activeJobs.length === 0 ? (
              <Text className="py-8 text-center text-sm text-muted-foreground">
                {t("dispatch.noActiveJobs")}
              </Text>
            ) : (
              activeJobs.map((job) => (
                <DispatchRow
                  key={job.id}
                  job={job}
                  detail={detailById.get(job.id)}
                />
              ))
            )}
          </Card>

          {/* All jobs (recent history) */}
          {jobs.length > activeJobs.length ? (
            <Card className="p-4">
              <Text className="pb-1 text-base font-semibold text-surface-foreground">
                {t("dispatch.recentTitle")}
              </Text>
              {jobs
                .filter((j) => !isActiveJob(j.status))
                .slice(0, 10)
                .map((job) => (
                  <DispatchRow key={job.id} job={job} />
                ))}
            </Card>
          ) : null}
        </>
      )}
    </View>
  );
}

export default function DispatchScreen() {
  return (
    <DashboardScreen title="Dispatch · Moovo Hub">
      <DispatchBody />
    </DashboardScreen>
  );
}
