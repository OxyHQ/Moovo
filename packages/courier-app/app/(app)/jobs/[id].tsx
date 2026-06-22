import { useState } from "react";
import { View, ScrollView, ActivityIndicator, Pressable } from "react-native";
import Head from "expo-router/head";
import { useLocalSearchParams } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useOxy, showSignInModal } from "@oxyhq/services";
import type { JobView, ScanInput, ShipmentEndpoint } from "@moovo/shared-types";
import { MapPin, Flag, Navigation, Package, Phone } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScreenHeader } from "@/components/courier/ScreenHeader";
import JobMap from "@/components/map/Map";
import type { MapMarker, LngLat } from "@/components/map/Map.types";
import { QrScanner } from "@/components/QrScanner";
import { useColorScheme } from "@/lib/useColorScheme";
import { queryKeys } from "@/lib/hooks/query-keys";
import { fetchJob, scanJob, startTransit } from "@/lib/api/jobs";
import { formatDisplayMoney } from "@/lib/money";
import { distanceMeters, formatDistance } from "@/lib/geo";
import { openInMaps } from "@/lib/maps-link";
import { errorMessage } from "@/lib/api/errors";
import { useLocationPings } from "@/lib/hooks/use-location-pings";
import {
  actionForStatus,
  navTarget,
  isActiveLeg,
  isTerminal,
  statusLabel,
} from "@/lib/job-flow";

/** Build the map markers + straight-line route for a job + optional courier fix. */
function buildMapData(
  job: JobView,
  courierFix: LngLat | null,
): { markers: MapMarker[]; route: LngLat[] } {
  const pickup = job.pickupSnapshot.location.coordinates;
  const dropoff = job.dropoffSnapshot.location.coordinates;
  const markers: MapMarker[] = [
    { id: "pickup", coordinate: pickup, kind: "pickup", label: "Pickup" },
    { id: "dropoff", coordinate: dropoff, kind: "dropoff", label: "Dropoff" },
  ];
  if (courierFix) {
    markers.push({ id: "courier", coordinate: courierFix, kind: "courier", label: "You" });
  }
  // v1 straight-line route: courier (when known) → pickup → dropoff.
  const route: LngLat[] = courierFix ? [courierFix, pickup, dropoff] : [pickup, dropoff];
  return { markers, route };
}

/** A pickup/dropoff endpoint summary block. */
function EndpointBlock({
  endpoint,
  icon,
  title,
}: {
  endpoint: ShipmentEndpoint;
  icon: React.ReactNode;
  title: string;
}) {
  const { address } = endpoint;
  return (
    <View className="flex-row gap-3">
      <View className="pt-0.5">{icon}</View>
      <View className="flex-1 gap-0.5">
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
          <Phone size={13} className="text-muted-foreground" />
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

function JobDetail({ job }: { job: JobView }) {
  const { colors } = useColorScheme();
  const queryClient = useQueryClient();
  const [scannerOpen, setScannerOpen] = useState(false);

  // Stream the courier's GPS to the backend while the job is in an active leg.
  const { fix, permissionDenied } = useLocationPings(job.id, isActiveLeg(job.status));
  const courierFix = fix ? fix.coordinates : null;

  const { markers, route } = buildMapData(job, courierFix);
  const action = actionForStatus(job.status);
  const target = navTarget(job);

  const legDistance = formatDistance(
    distanceMeters(job.pickupSnapshot.location, job.dropoffSnapshot.location),
  );

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.jobs.detail(job.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.jobs.courier });
  };

  const scanMutation = useMutation({
    mutationFn: (input: ScanInput) => scanJob(job.id, input),
    onSuccess: () => {
      setScannerOpen(false);
      invalidate();
    },
  });

  const transitMutation = useMutation({
    mutationFn: () => {
      const ping = courierFix
        ? { lng: courierFix[0], lat: courierFix[1] }
        : {};
      return startTransit(job.id, ping);
    },
    onSuccess: invalidate,
  });

  const busy = scanMutation.isPending || transitMutation.isPending;
  const fare = formatDisplayMoney(job.totals.total);

  const handleScanned = (code: string) => {
    if (action.kind !== "scan") return;
    const input: ScanInput = { leg: action.leg, code };
    scanMutation.mutate(input);
  };

  return (
    <View className="gap-4 p-4">
      {/* Map */}
      <View className="h-72 overflow-hidden rounded-2xl border border-border">
        <JobMap markers={markers} route={route} />
      </View>

      {/* Status + fare */}
      <Card>
        <CardContent className="gap-3 pt-5">
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center gap-2">
              <Package size={18} color={colors.primary} />
              <Text className="text-base font-bold capitalize text-surface-foreground">
                {job.type} · {job.jobNumber}
              </Text>
            </View>
            <View className="rounded-full bg-primary/10 px-3 py-1">
              <Text className="text-xs font-semibold text-primary">
                {statusLabel(job.status)}
              </Text>
            </View>
          </View>
          <View className="flex-row items-center justify-between">
            <Text className="text-sm text-muted-foreground">{legDistance} leg</Text>
            <Text className="text-lg font-bold text-surface-foreground">{fare}</Text>
          </View>
        </CardContent>
      </Card>

      {/* Endpoints */}
      <Card>
        <CardContent className="gap-4 pt-5">
          <EndpointBlock
            endpoint={job.pickupSnapshot}
            title="Pickup"
            icon={<MapPin size={18} color={colors.primary} />}
          />
          <View className="h-px bg-border" />
          <EndpointBlock
            endpoint={job.dropoffSnapshot}
            title="Dropoff"
            icon={<Flag size={18} color={colors.primary} />}
          />
        </CardContent>
      </Card>

      {permissionDenied && isActiveLeg(job.status) ? (
        <Card className="border-amber-500/40">
          <CardContent className="pt-5">
            <Text className="text-sm text-muted-foreground">
              Location is off. Enable it so the sender can track your progress.
            </Text>
          </CardContent>
        </Card>
      ) : null}

      {scanMutation.isError ? (
        <Card className="border-destructive">
          <CardContent className="pt-5">
            <Text className="text-sm text-destructive">
              {errorMessage(scanMutation.error, "Scan failed — try again")}
            </Text>
          </CardContent>
        </Card>
      ) : null}
      {transitMutation.isError ? (
        <Card className="border-destructive">
          <CardContent className="pt-5">
            <Text className="text-sm text-destructive">
              {errorMessage(transitMutation.error, "Could not start delivery")}
            </Text>
          </CardContent>
        </Card>
      ) : null}

      {/* Step actions */}
      {isTerminal(job.status) ? (
        <Card>
          <CardContent className="items-center gap-1 py-8">
            <Text className="text-base font-semibold text-surface-foreground">
              {job.status === "delivered" ? "Delivered" : "Cancelled"}
            </Text>
            <Text className="text-sm text-muted-foreground">
              {job.status === "delivered"
                ? "This job is complete."
                : "This job is no longer active."}
            </Text>
          </CardContent>
        </Card>
      ) : (
        <View className="gap-3">
          {target ? (
            <Button
              variant="outline"
              size="lg"
              onPress={() =>
                openInMaps(
                  target.location,
                  action.kind === "scan" ? action.navLabel : undefined,
                )
              }
            >
              <View className="flex-row items-center gap-2">
                <Navigation size={18} color={colors.foreground} />
                <Text className="text-base font-semibold text-foreground">
                  {action.kind === "scan" ? action.navLabel : "Open in Maps"}
                </Text>
              </View>
            </Button>
          ) : null}

          {action.kind === "scan" ? (
            <Button size="lg" disabled={busy} onPress={() => setScannerOpen(true)}>
              <Text className="text-base font-semibold text-primary-foreground">
                {action.label}
              </Text>
            </Button>
          ) : null}

          {action.kind === "transition" ? (
            <Button size="lg" disabled={busy} onPress={() => transitMutation.mutate()}>
              {transitMutation.isPending ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <Text className="text-base font-semibold text-primary-foreground">
                  {action.label}
                </Text>
              )}
            </Button>
          ) : null}
        </View>
      )}

      {action.kind === "scan" ? (
        <QrScanner
          visible={scannerOpen}
          jobId={job.id}
          leg={action.leg}
          onScanned={handleScanned}
          onClose={() => setScannerOpen(false)}
        />
      ) : null}
    </View>
  );
}

export default function JobScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { isAuthenticated, isAuthResolved, canUsePrivateApi } = useOxy();
  const { colors } = useColorScheme();

  const jobQuery = useQuery({
    queryKey: queryKeys.jobs.detail(id),
    queryFn: () => fetchJob(id),
    enabled: canUsePrivateApi && !!id,
  });

  let body: React.ReactNode;
  if (!isAuthResolved) {
    body = (
      <View className="items-center py-24">
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  } else if (!isAuthenticated) {
    body = (
      <View className="items-center gap-4 px-8 py-24">
        <Text className="text-center text-base text-muted-foreground">
          Sign in to view this job.
        </Text>
        <Pressable onPress={() => showSignInModal()}>
          <Text className="font-semibold text-primary">Sign in</Text>
        </Pressable>
      </View>
    );
  } else if (jobQuery.isLoading || !canUsePrivateApi) {
    body = (
      <View className="items-center py-24">
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  } else if (jobQuery.isError || !jobQuery.data?.data) {
    body = (
      <Text className="px-8 py-24 text-center text-sm text-muted-foreground">
        {errorMessage(jobQuery.error, "Could not load this job")}
      </Text>
    );
  } else {
    body = <JobDetail job={jobQuery.data.data} />;
  }

  return (
    <View className="flex-1 bg-background">
      <Head>
        <title>Job · Moovo Go</title>
      </Head>
      <ScreenHeader title="Active job" />
      <ScrollView
        className="flex-1"
        contentContainerClassName="pb-24 mx-auto w-full max-w-2xl"
      >
        {body}
      </ScrollView>
    </View>
  );
}
