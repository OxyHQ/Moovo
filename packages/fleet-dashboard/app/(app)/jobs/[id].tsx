import type { ReactNode } from "react";
import { View, ActivityIndicator } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, MapPin, Flag, Phone } from "lucide-react-native";
import { useOxy } from "@oxyhq/services";
import type { JobView, JobStatusEvent, ShipmentEndpoint } from "@moovo/shared-types";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DashboardScreen } from "@/components/dashboard/DashboardScreen";
import { StatusChip } from "@/components/dashboard/StatusChip";
import { FleetMap } from "@/components/dashboard/Map";
import type { MapMarker } from "@/components/dashboard/map-types";
import { fetchJob } from "@/lib/api/jobs";
import { useColorScheme } from "@/lib/useColorScheme";
import { useTranslation } from "@/hooks/useTranslation";
import {
  formatMoney,
  formatTime,
  formatDate,
  jobStatusKey,
  jobTypeKey,
} from "@/lib/format";
import { useI18nStore } from "@/lib/stores/i18n-store";

/** Map height for the route overview. */
const MAP_HEIGHT = 320;

/** A pickup/dropoff endpoint summary block. */
function EndpointBlock({
  endpoint,
  icon,
  title,
}: {
  endpoint: ShipmentEndpoint;
  icon: ReactNode;
  title: string;
}) {
  const { colors } = useColorScheme();
  const { address } = endpoint;
  return (
    <View className="flex-row gap-3">
      <View className="pt-0.5">{icon}</View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </Text>
        <Text className="text-sm font-medium text-surface-foreground">
          {address.line1}
          {address.line2 ? `, ${address.line2}` : ""}
        </Text>
        <Text className="text-sm text-muted-foreground">
          {address.city}
          {address.postalCode ? ` ${address.postalCode}` : ""}
        </Text>
        <View className="mt-1 flex-row items-center gap-2">
          <Phone size={13} color={colors.mutedForeground} />
          <Text className="text-sm text-muted-foreground">
            {endpoint.contactName} · {endpoint.contactPhone}
          </Text>
        </View>
        {endpoint.notes ? (
          <Text className="mt-1 text-sm italic text-muted-foreground">
            “{endpoint.notes}”
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** One row in the job's status timeline (most-recent-first). */
function TimelineRow({
  event,
  isLast,
}: {
  event: JobStatusEvent;
  isLast: boolean;
}) {
  const { t } = useTranslation();
  const locale = useI18nStore((s) => s.locale);

  return (
    <View className="flex-row gap-3">
      {/* Rail: dot + connecting line. */}
      <View className="items-center">
        <View className="mt-1.5 h-2.5 w-2.5 rounded-full bg-primary" />
        {!isLast ? <View className="w-px flex-1 bg-border" /> : null}
      </View>
      <View className={isLast ? "flex-1" : "flex-1 pb-4"}>
        <Text className="text-sm font-medium text-surface-foreground">
          {t(jobStatusKey(event.status))}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {formatDate(event.at, locale)} · {formatTime(event.at, locale)}
        </Text>
        {event.note ? (
          <Text className="mt-0.5 text-sm text-muted-foreground">
            {event.note}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** The read-only dispatcher job view, mounted once the job is loaded. */
function JobDetailBody({ job }: { job: JobView }) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();

  const [pLng, pLat] = job.pickupSnapshot.location.coordinates;
  const [dLng, dLat] = job.dropoffSnapshot.location.coordinates;
  const markers: MapMarker[] = [
    {
      id: "pickup",
      lng: pLng,
      lat: pLat,
      kind: "pickup",
      label: `${t("job.pickup")} · ${job.pickupSnapshot.address.city}`,
    },
    {
      id: "dropoff",
      lng: dLng,
      lat: dLat,
      kind: "dropoff",
      label: `${t("job.dropoff")} · ${job.dropoffSnapshot.address.city}`,
    },
  ];

  // Status history newest-first for the timeline.
  const timeline = [...job.statusHistory].reverse();

  return (
    <View className="gap-6">
      <FleetMap markers={markers} height={MAP_HEIGHT} />

      {/* Header card: job number, type, status, total. */}
      <Card className="gap-3 p-4">
        <View className="flex-row items-center justify-between gap-3">
          <View className="min-w-0 flex-1">
            <Text className="text-lg font-bold text-surface-foreground">
              {job.jobNumber}
            </Text>
            <Text className="text-sm text-muted-foreground">
              {t(jobTypeKey(job.type))}
            </Text>
          </View>
          <StatusChip status={job.status} />
        </View>
        <View className="flex-row items-center justify-between">
          <Text className="text-sm text-muted-foreground">{t("job.total")}</Text>
          <Text className="text-lg font-bold text-surface-foreground">
            {formatMoney(job.totals.total)}
          </Text>
        </View>
      </Card>

      {/* Endpoints. */}
      <Card className="gap-4 p-4">
        <EndpointBlock
          endpoint={job.pickupSnapshot}
          title={t("job.pickup")}
          icon={<MapPin size={18} color={colors.primary} />}
        />
        <View className="h-px bg-border" />
        <EndpointBlock
          endpoint={job.dropoffSnapshot}
          title={t("job.dropoff")}
          icon={<Flag size={18} color={colors.primary} />}
        />
      </Card>

      {/* Status timeline. */}
      <Card className="gap-3 p-4">
        <Text className="text-base font-semibold text-surface-foreground">
          {t("job.timeline")}
        </Text>
        {timeline.map((event, index) => (
          <TimelineRow
            key={`${event.status}-${event.at}`}
            event={event}
            isLast={index === timeline.length - 1}
          />
        ))}
      </Card>
    </View>
  );
}

export default function JobScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const { canUsePrivateApi } = useOxy();

  // Share the dispatch board's per-job detail cache key shape exactly so the
  // board's prefetched detail and this screen hit the same cache entry.
  const jobQuery = useQuery({
    queryKey: ["jobs", "detail", id],
    queryFn: () => fetchJob(id),
    enabled: canUsePrivateApi && !!id,
  });

  let body: ReactNode;
  if (jobQuery.isPending || !canUsePrivateApi) {
    body = (
      <View className="items-center py-24">
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  } else if (jobQuery.isError || !jobQuery.data) {
    body = (
      <Text className="px-8 py-24 text-center text-sm text-muted-foreground">
        {t("job.loadError")}
      </Text>
    );
  } else {
    body = <JobDetailBody job={jobQuery.data} />;
  }

  return (
    <DashboardScreen title={t("job.title")}>
      <View className="gap-6 px-5 py-8 md:px-8">
        <View className="flex-row items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onPress={() => router.back()}
            className="h-9 w-9 rounded-full"
            accessibilityLabel={t("common.back")}
          >
            <ArrowLeft size={20} color={colors.foreground} />
          </Button>
          <Text className="text-2xl font-bold text-foreground">
            {t("job.header")}
          </Text>
        </View>
        {body}
      </View>
    </DashboardScreen>
  );
}
