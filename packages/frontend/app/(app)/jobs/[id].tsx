import { useMemo, useState } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import Head from 'expo-router/head';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { RiBox3Line } from '@oxy.so/bloom/icons/RiBox3Line';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiMapPinLine } from '@oxy.so/bloom/icons/RiMapPinLine';
import { RiPhoneLine } from '@oxy.so/bloom/icons/RiPhoneLine';
import { Loading } from '@oxy.so/bloom/loading';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Text } from '@oxy.so/bloom/typography';
import { StatusBadge } from '@/components/transport/StatusBadge';
import { MoneyText } from '@/components/transport/MoneyText';
import { StatusTimeline } from '@/components/transport/StatusTimeline';
import { CourierInfo } from '@/components/transport/CourierInfo';
import { QrCard } from '@/components/transport/QrCard';
import MoovoMap from '@/components/Map';
import type { MapMarker } from '@/components/map-types';
import { useTheme } from '@oxy.so/bloom/theme';
import { useJob, useCancelJob } from '@/lib/hooks/use-jobs';
import { useJobSocket } from '@/lib/hooks/use-job-socket';
import { SHIPMENT_TYPES } from '@/lib/shipment-type';
import type { JobView, JobEndpointSnapshot } from '@moovo/shared-types';

/** A job status where the sender may still cancel (non-terminal). */
function isCancellable(status: JobView['status']): boolean {
  return status !== 'delivered' && status !== 'cancelled';
}

/** Whether the QR codes are meaningful to show (pre-delivery, active job). */
function showsCodes(status: JobView['status']): boolean {
  return status === 'accepted' || status === 'picked_up' || status === 'in_transit';
}

/** An address summary block for an endpoint snapshot. */
function EndpointBlock({ label, endpoint }: { label: string; endpoint: JobEndpointSnapshot }) {
  const { colors } = useTheme();
  const { address } = endpoint;
  const line2 = [address.postalCode, address.city, address.region].filter(Boolean).join(', ');
  return (
    <View className="flex-row gap-3">
      <RiMapPinLine width={16} fill={colors.textSecondary} style={{ marginTop: 2 }} />
      <View className="flex-1">
        <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </Text>
        <Text className="text-sm text-foreground">{address.line1}</Text>
        {address.line2 ? <Text className="text-sm text-foreground">{address.line2}</Text> : null}
        <Text className="text-sm text-muted-foreground">{line2}</Text>
        <View className="mt-1 flex-row items-center gap-1.5">
          <RiPhoneLine width={12} fill={colors.textSecondary} />
          <Text className="text-xs text-muted-foreground">
            {endpoint.contactName} · {endpoint.contactPhone}
          </Text>
        </View>
        {endpoint.notes ? (
          <Text className="mt-1 text-xs italic text-muted-foreground">"{endpoint.notes}"</Text>
        ) : null}
      </View>
    </View>
  );
}

export default function JobTrackingScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();

  const { data: job, isLoading } = useJob(id);
  const courierPosition = useJobSocket(id);
  const cancel = useCancelJob(id);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // Build the map markers: pickup + dropoff (from snapshots) + the live courier
  // position (from the socket), or the most recent stored ping as a fallback.
  const markers = useMemo<MapMarker[]>(() => {
    if (!job) {
      return [];
    }
    const result: MapMarker[] = [
      {
        id: 'pickup',
        kind: 'pickup',
        coordinate: job.pickupSnapshot.location.coordinates,
        label: 'Pickup',
      },
      {
        id: 'dropoff',
        kind: 'dropoff',
        coordinate: job.dropoffSnapshot.location.coordinates,
        label: 'Dropoff',
      },
    ];
    const courierCoord =
      courierPosition?.coordinates ??
      job.locationPings[job.locationPings.length - 1]?.location.coordinates;
    if (courierCoord) {
      result.push({ id: 'courier', kind: 'courier', coordinate: courierCoord, label: 'Courier' });
    }
    return result;
  }, [job, courierPosition]);

  const handleCancel = async () => {
    setCancelError(null);
    try {
      await cancel.mutateAsync();
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : 'Could not cancel this job.');
    }
  };

  if (isLoading || !job) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Loading variant="spinner" size="sm" />
      </View>
    );
  }

  const typeMeta = SHIPMENT_TYPES[job.type];

  return (
    <View className="flex-1 bg-background">
      <Head>
        <title>{job.jobNumber} · Moovo</title>
      </Head>

      <PageHeader
        presentation="bar"
        title={job.jobNumber}
        subtitle={typeMeta.label}
        onBack={() => router.replace('/(app)')}
        actions={<StatusBadge status={job.status} />}
      />

      <ScrollView className="flex-1" contentContainerClassName="px-4 py-4 pb-24">
        <View className="web:mx-auto web:w-full web:max-w-[640px] gap-4">
          {/* Live map. */}
          <View className="h-72 overflow-hidden rounded-2xl border border-border">
            <MoovoMap markers={markers} fitToMarkers />
          </View>

          {/* Courier (once assigned). */}
          {job.courierOxyUserId ? <CourierInfo courierOxyUserId={job.courierOxyUserId} /> : null}

          {/* QR codes for pickup/dropoff handoff (owner-scoped, active job). */}
          {showsCodes(job.status) && (job.pickupCode || job.dropoffCode) ? (
            <View className="gap-3">
              {job.pickupCode ? <QrCard title="Pickup code" code={job.pickupCode} /> : null}
              {job.dropoffCode ? <QrCard title="Dropoff code" code={job.dropoffCode} /> : null}
            </View>
          ) : null}

          {/* Status timeline. */}
          <StatusTimeline status={job.status} history={job.statusHistory} />

          {/* Route + parcel + fare. */}
          <View className="gap-4 rounded-2xl border border-border bg-card p-4">
            <EndpointBlock label="Pickup" endpoint={job.pickupSnapshot} />
            <View className="h-px w-full" style={{ backgroundColor: colors.border }} />
            <EndpointBlock label="Dropoff" endpoint={job.dropoffSnapshot} />
            <View className="h-px w-full" style={{ backgroundColor: colors.border }} />
            <View className="flex-row items-center gap-3">
              <RiBox3Line width={16} fill={colors.textSecondary} />
              <Text className="flex-1 text-sm text-foreground">
                {job.parcelSnapshot.pieces} piece
                {job.parcelSnapshot.pieces === 1 ? '' : 's'} · {job.parcelSnapshot.weightKg} kg ·{' '}
                {job.parcelSnapshot.sizeClass}
                {job.parcelSnapshot.fragile ? ' · fragile' : ''}
              </Text>
            </View>
            <View className="flex-row items-center justify-between">
              <Text className="text-sm font-medium text-muted-foreground">Total fare</Text>
              <MoneyText money={job.totals.total} />
            </View>
          </View>

          {/* Cancel (non-terminal only). */}
          {isCancellable(job.status) ? (
            <Pressable
              onPress={handleCancel}
              disabled={cancel.isPending}
              accessibilityRole="button"
              className="flex-row items-center justify-center gap-2 rounded-xl border border-red-500/40 py-3 active:opacity-80"
            >
              {cancel.isPending ? (
                <Loading variant="spinner" size="sm" />
              ) : (
                <RiCloseLine width={16} fill="#dc2626" />
              )}
              <Text className="text-sm font-semibold text-red-600">Cancel delivery</Text>
            </Pressable>
          ) : null}
          {cancelError ? (
            <Text className="text-center text-sm text-red-600">{cancelError}</Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}
