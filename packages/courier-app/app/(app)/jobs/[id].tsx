import { useState } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { Loading } from '@oxy.so/bloom/loading';
import Head from 'expo-router/head';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services/ui/client';
import type { JobView, ScanInput, ShipmentEndpoint } from '@moovo/shared-types';
import { RiBox3Line } from '@oxy.so/bloom/icons/RiBox3Line';
import { RiCompass3Line } from '@oxy.so/bloom/icons/RiCompass3Line';
import { RiFlagLine } from '@oxy.so/bloom/icons/RiFlagLine';
import { RiMapPinLine } from '@oxy.so/bloom/icons/RiMapPinLine';
import { RiPhoneLine } from '@oxy.so/bloom/icons/RiPhoneLine';
import { Text } from '@oxy.so/bloom/typography';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { PageHeader } from '@oxy.so/bloom/page-header';
import JobMap from '@/components/map/Map';
import type { MapMarker, LngLat } from '@/components/map/Map.types';
import { QrScanner } from '@/components/QrScanner';
import { useTheme } from '@oxy.so/bloom/theme';
import { queryKeys } from '@/lib/hooks/query-keys';
import { fetchJob, scanJob, startTransit } from '@/lib/api/jobs';
import { formatDisplayMoney } from '@/lib/money';
import { distanceMeters, formatDistance } from '@/lib/geo';
import { openInMaps } from '@/lib/maps-link';
import { errorMessage } from '@/lib/api/errors';
import { useLocationPings } from '@/lib/hooks/use-location-pings';
import { actionForStatus, navTarget, isActiveLeg, isTerminal, statusLabel } from '@/lib/job-flow';

/** Build the map markers + straight-line route for a job + optional courier fix. */
function buildMapData(
  job: JobView,
  courierFix: LngLat | null,
): { markers: MapMarker[]; route: LngLat[] } {
  const pickup = job.pickupSnapshot.location.coordinates;
  const dropoff = job.dropoffSnapshot.location.coordinates;
  const markers: MapMarker[] = [
    { id: 'pickup', coordinate: pickup, kind: 'pickup', label: 'Pickup' },
    { id: 'dropoff', coordinate: dropoff, kind: 'dropoff', label: 'Dropoff' },
  ];
  if (courierFix) {
    markers.push({ id: 'courier', coordinate: courierFix, kind: 'courier', label: 'You' });
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
  const { colors } = useTheme();
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
          {address.line2 ? `, ${address.line2}` : ''}
        </Text>
        <Text className="text-sm text-muted-foreground">
          {address.city}
          {address.postalCode ? ` ${address.postalCode}` : ''}
        </Text>
        <View className="mt-1 flex-row items-center gap-2">
          <RiPhoneLine width={13} height={13} fill={colors.textSecondary} />
          <Text className="text-sm text-muted-foreground">
            {endpoint.contactName} · {endpoint.contactPhone}
          </Text>
        </View>
        {endpoint.notes ? (
          <Text className="mt-1 text-sm italic text-muted-foreground">“{endpoint.notes}”</Text>
        ) : null}
      </View>
    </View>
  );
}

function JobDetail({ job }: { job: JobView }) {
  const { colors } = useTheme();
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
      const ping = courierFix ? { lng: courierFix[0], lat: courierFix[1] } : {};
      return startTransit(job.id, ping);
    },
    onSuccess: invalidate,
  });

  const busy = scanMutation.isPending || transitMutation.isPending;
  const fare = formatDisplayMoney(job.totals.total);

  const handleScanned = (code: string) => {
    if (action.kind !== 'scan') return;
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
      <Card className="gap-3 p-4">
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-2">
            <RiBox3Line width={18} height={18} fill={colors.primary} />
            <Text className="text-base font-bold capitalize text-surface-foreground">
              {job.type} · {job.jobNumber}
            </Text>
          </View>
          <View className="rounded-full bg-primary/10 px-3 py-1">
            <Text className="text-xs font-semibold text-primary">{statusLabel(job.status)}</Text>
          </View>
        </View>
        <View className="flex-row items-center justify-between">
          <Text className="text-sm text-muted-foreground">{legDistance} leg</Text>
          <Text className="text-lg font-bold text-surface-foreground">{fare}</Text>
        </View>
      </Card>

      {/* Endpoints */}
      <Card className="gap-4 p-4">
        <EndpointBlock
          endpoint={job.pickupSnapshot}
          title="Pickup"
          icon={<RiMapPinLine width={18} height={18} fill={colors.primary} />}
        />
        <View className="h-px bg-border" />
        <EndpointBlock
          endpoint={job.dropoffSnapshot}
          title="Dropoff"
          icon={<RiFlagLine width={18} height={18} fill={colors.primary} />}
        />
      </Card>

      {permissionDenied && isActiveLeg(job.status) ? (
        <Card className="border-amber-500/40 p-4">
          <Text className="text-sm text-muted-foreground">
            Location is off. Enable it so the sender can track your progress.
          </Text>
        </Card>
      ) : null}

      {scanMutation.isError ? (
        <Card className="border-destructive p-4">
          <Text className="text-sm text-destructive">
            {errorMessage(scanMutation.error, 'Scan failed — try again')}
          </Text>
        </Card>
      ) : null}
      {transitMutation.isError ? (
        <Card className="border-destructive p-4">
          <Text className="text-sm text-destructive">
            {errorMessage(transitMutation.error, 'Could not start delivery')}
          </Text>
        </Card>
      ) : null}

      {/* Step actions */}
      {isTerminal(job.status) ? (
        <Card className="items-center gap-1 p-4">
          <Text className="text-base font-semibold text-surface-foreground">
            {job.status === 'delivered' ? 'Delivered' : 'Cancelled'}
          </Text>
          <Text className="text-sm text-muted-foreground">
            {job.status === 'delivered' ? 'This job is complete.' : 'This job is no longer active.'}
          </Text>
        </Card>
      ) : (
        <View className="gap-3">
          {target ? (
            <Button
              appearance="outline"
              tone="neutral"
              size="lg"
              onPress={() =>
                openInMaps(target.location, action.kind === 'scan' ? action.navLabel : undefined)
              }
              leadingIcon={RiCompass3Line}
            >
              {action.kind === 'scan' ? action.navLabel : 'Open in Maps'}
            </Button>
          ) : null}

          {action.kind === 'scan' ? (
            <Button size="lg" onPress={() => setScannerOpen(true)} disabled={busy}>
              {action.label}
            </Button>
          ) : null}

          {action.kind === 'transition' ? (
            <Button
              size="lg"
              disabled={busy}
              loading={transitMutation.isPending}
              onPress={() => transitMutation.mutate()}
            >
              {action.label}
            </Button>
          ) : null}
        </View>
      )}

      {action.kind === 'scan' ? (
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
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { isAuthenticated, isAuthResolved, canUsePrivateApi, openAccountDialog } = useOxy();

  const jobQuery = useQuery({
    queryKey: queryKeys.jobs.detail(id),
    queryFn: () => fetchJob(id),
    enabled: canUsePrivateApi && !!id,
  });

  let body: React.ReactNode;
  if (!isAuthResolved) {
    body = (
      <View className="items-center py-24">
        <Loading variant="spinner" size="sm" />
      </View>
    );
  } else if (!isAuthenticated) {
    body = (
      <View className="items-center gap-4 px-8 py-24">
        <Text className="text-center text-base text-muted-foreground">
          Sign in to view this job.
        </Text>
        <Pressable onPress={() => openAccountDialog()}>
          <Text className="font-semibold text-primary">Sign in</Text>
        </Pressable>
      </View>
    );
  } else if (jobQuery.isLoading || !canUsePrivateApi) {
    body = (
      <View className="items-center py-24">
        <Loading variant="spinner" size="sm" />
      </View>
    );
  } else if (jobQuery.isError || !jobQuery.data?.data) {
    body = (
      <Text className="px-8 py-24 text-center text-sm text-muted-foreground">
        {errorMessage(jobQuery.error, 'Could not load this job')}
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
      <PageHeader presentation="bar" title="Active job" onBack={() => router.back()} />
      <ScrollView className="flex-1" contentContainerClassName="pb-24 mx-auto w-full max-w-2xl">
        {body}
      </ScrollView>
    </View>
  );
}
