import { useMemo } from 'react';
import { View, ScrollView, Pressable, Platform } from 'react-native';
import Head from 'expo-router/head';
import { useRouter } from 'expo-router';
import { useOxy } from '@oxy.so/services/ui/client';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiBox3Line } from '@oxy.so/bloom/icons/RiBox3Line';
import { Button } from '@oxy.so/bloom/button';
import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@oxy.so/bloom/typography';
import { Footer } from '@/components/shell/Footer';
import { StatusBadge } from '@/components/transport/StatusBadge';
import { MoneyText } from '@/components/transport/MoneyText';
import { RouteSummary } from '@/components/transport/RouteSummary';
import { useTheme } from '@oxy.so/bloom/theme';
import { useMyShipments } from '@/lib/hooks/use-shipments';
import { useMyJobs } from '@/lib/hooks/use-jobs';
import { SHIPMENT_TYPES } from '@/lib/shipment-type';
import type { Shipment, JobSummary } from '@moovo/shared-types';

/** Spread (px) of the gutter-color mask around the rounded frame (desktop). */
const GUTTER_MASK_SPREAD = 40;

/** How many records to pull per kind for the Orders list. */
const PAGE_LIMIT = 50;

/**
 * A merged Orders entry — either a still-open shipment (pre-booking) or a booked
 * job. `at` is the entry's creation time, used to interleave both kinds by
 * recency in one chronological list.
 */
type OrderEntry =
  | { kind: 'shipment'; at: number; shipment: Shipment }
  | { kind: 'job'; at: number; job: JobSummary };

/** Parse an ISO-8601 timestamp to epoch ms (0 when missing/invalid). */
function toEpoch(iso: string | undefined): number {
  if (!iso) {
    return 0;
  }
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** A still-open shipment row (pre-booking: quoting / quoted / cancelled …). */
function ShipmentRow({ shipment }: { shipment: Shipment }) {
  const router = useRouter();
  const { colors } = useTheme();
  const meta = SHIPMENT_TYPES[shipment.type];
  const Icon = meta.icon;
  return (
    <Pressable
      onPress={() => router.push(`/shipments/${shipment.id}/quotes`)}
      accessibilityRole="button"
      accessibilityLabel={`${meta.label} shipment from ${shipment.pickup.address.city} to ${shipment.dropoff.address.city}`}
      className="flex-row items-center gap-3 rounded-2xl border border-border bg-card p-4 active:opacity-80"
    >
      <View className="h-10 w-10 items-center justify-center rounded-full bg-muted">
        <Icon width={18} fill={colors.textSecondary} />
      </View>
      <View className="flex-1 gap-1">
        <View className="flex-row items-center justify-between">
          <Text className="text-sm font-semibold text-foreground">{meta.label}</Text>
          <StatusBadge status={shipment.status} />
        </View>
        <RouteSummary from={shipment.pickup.address.city} to={shipment.dropoff.address.city} />
      </View>
      <RiArrowRightSLine width={18} height={18} fill={colors.textSecondary} />
    </Pressable>
  );
}

/** A booked job row (requested → delivered). */
function JobRow({ job }: { job: JobSummary }) {
  const router = useRouter();
  const { colors } = useTheme();
  const meta = SHIPMENT_TYPES[job.type];
  const Icon = meta.icon;
  return (
    <Pressable
      onPress={() => router.push(`/jobs/${job.id}`)}
      accessibilityRole="button"
      accessibilityLabel={`Delivery ${job.jobNumber}`}
      className="flex-row items-center gap-3 rounded-2xl border border-border bg-card p-4 active:opacity-80"
    >
      <View className="h-10 w-10 items-center justify-center rounded-full bg-muted">
        <Icon width={18} fill={colors.textSecondary} />
      </View>
      <View className="flex-1 gap-1">
        <View className="flex-row items-center justify-between">
          <Text className="text-sm font-semibold text-foreground">{job.jobNumber}</Text>
          <StatusBadge status={job.status} />
        </View>
        <View className="flex-row items-center justify-between gap-2">
          <Text className="text-xs text-muted-foreground">{meta.label}</Text>
          <MoneyText money={job.totals.total} size="sm" />
        </View>
      </View>
      <RiArrowRightSLine width={18} height={18} fill={colors.textSecondary} />
    </Pressable>
  );
}

/** Empty state — no orders yet, with a CTA into the create flow. */
function EmptyOrders() {
  const router = useRouter();
  const { colors } = useTheme();
  return (
    <View className="items-center rounded-2xl border border-dashed border-border bg-card/50 px-6 py-12">
      <View className="mb-3 h-12 w-12 items-center justify-center rounded-full bg-primary/10">
        <RiBox3Line width={24} fill={colors.primary} />
      </View>
      <Text className="text-sm font-medium text-foreground">No orders yet</Text>
      <Text className="mt-1 text-center text-xs text-muted-foreground">
        Shipments you create and deliveries you book will show up here.
      </Text>
      <Button className="mt-4" onPress={() => router.push('/send')}>
        Send something
      </Button>
    </View>
  );
}

/** Signed-out prompt — orders are owner-scoped, so ask the visitor to sign in. */
function SignedOutPrompt() {
  const { openAccountDialog } = useOxy();
  return (
    <View className="items-center rounded-2xl border border-dashed border-border bg-card/50 px-6 py-12">
      <Text className="text-sm font-medium text-foreground">Sign in to see your orders</Text>
      <Text className="mt-1 text-center text-xs text-muted-foreground">
        Your shipments and booked deliveries live in your account.
      </Text>
      <Button className="mt-4" onPress={() => openAccountDialog()}>
        Sign in
      </Button>
    </View>
  );
}

/** The signed-in orders list: open shipments + booked jobs, merged by recency. */
function OrdersList() {
  const { data: jobsPage, isLoading: jobsLoading } = useMyJobs({ limit: PAGE_LIMIT });
  const { data: shipmentsPage, isLoading: shipmentsLoading } = useMyShipments({
    limit: PAGE_LIMIT,
  });

  // Booked shipments live as jobs, so drop them here to avoid showing the same
  // order twice (the job is the authoritative, trackable record once booked).
  const entries = useMemo<OrderEntry[]>(() => {
    const jobs = jobsPage?.data ?? [];
    const openShipments = (shipmentsPage?.data ?? []).filter((s) => s.status !== 'booked');
    const merged: OrderEntry[] = [
      ...jobs.map((job) => ({ kind: 'job' as const, at: toEpoch(job.createdAt), job })),
      ...openShipments.map((shipment) => ({
        kind: 'shipment' as const,
        at: toEpoch(shipment.createdAt),
        shipment,
      })),
    ];
    return merged.sort((a, b) => b.at - a.at);
  }, [jobsPage?.data, shipmentsPage?.data]);

  const loading = jobsLoading || shipmentsLoading;

  if (loading) {
    return (
      <View className="items-center py-12">
        <Loading variant="spinner" size="sm" />
      </View>
    );
  }

  if (entries.length === 0) {
    return <EmptyOrders />;
  }

  return (
    <View className="gap-3">
      {entries.map((entry) =>
        entry.kind === 'job' ? (
          <JobRow key={`job-${entry.job.id}`} job={entry.job} />
        ) : (
          <ShipmentRow key={`shipment-${entry.shipment.id}`} shipment={entry.shipment} />
        ),
      )}
    </View>
  );
}

function OrdersBody() {
  const { isAuthenticated } = useOxy();
  return (
    <>
      <View className="px-4 pb-2 pt-10">
        <Text className="text-2xl font-bold text-foreground">Orders</Text>
        <Text className="mt-1 text-sm text-muted-foreground">
          Your shipments and booked deliveries.
        </Text>
      </View>

      <View className="px-4 pt-2">{isAuthenticated ? <OrdersList /> : <SignedOutPrompt />}</View>

      <Footer />
    </>
  );
}

export default function OrdersScreen() {
  const { colors } = useTheme();
  const isWeb = Platform.OS === 'web';

  const head = (
    <Head>
      <title>Orders · Moovo</title>
      <meta name="description" content="Your Moovo shipments and booked deliveries." />
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
          <View className="web:mx-auto web:w-full web:max-w-[1100px]">
            <OrdersBody />
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
        <OrdersBody />
      </ScrollView>
    </View>
  );
}
