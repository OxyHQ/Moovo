import { View, ScrollView, Pressable, Platform } from 'react-native';
import Head from 'expo-router/head';
import { useRouter } from 'expo-router';
import { useOxy, openAccountDialog } from '@oxyhq/services';
import { ChevronRight } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Footer } from '@/components/shell/Footer';
import { MoovoWordmark } from '@/components/ui/moovo-wordmark';
import { StatusBadge } from '@/components/transport/StatusBadge';
import { MoneyText } from '@/components/transport/MoneyText';
import { RouteSummary } from '@/components/transport/RouteSummary';
import { useColorScheme } from '@/lib/useColorScheme';
import { useMyShipments } from '@/lib/hooks/use-shipments';
import { useMyJobs } from '@/lib/hooks/use-jobs';
import { SHIPMENT_TYPES, SHIPMENT_TYPE_ORDER } from '@/lib/shipment-type';
import type { Shipment, JobSummary, ShipmentType } from '@moovo/shared-types';

/** Spread (px) of the gutter-color mask around the rounded frame (desktop). */
const GUTTER_MASK_SPREAD = 40;

/** The big "Send something" CTA: pick a type → go to the create flow. */
function SendCta() {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { isAuthenticated } = useOxy();

  const handlePick = (type: ShipmentType) => {
    if (!isAuthenticated) {
      openAccountDialog();
      return;
    }
    router.push(`/send?type=${type}`);
  };

  return (
    <View className="px-4 pt-2">
      <Text className="mb-1 text-2xl font-bold text-foreground">Send something</Text>
      <Text className="mb-4 text-sm text-muted-foreground">
        Choose what you want to move. We'll find you the best courier.
      </Text>
      <View className="flex-row flex-wrap gap-3">
        {SHIPMENT_TYPE_ORDER.map((type) => {
          const meta = SHIPMENT_TYPES[type];
          const Icon = meta.icon;
          return (
            <Pressable
              key={type}
              onPress={() => handlePick(type)}
              accessibilityRole="button"
              accessibilityLabel={`Send a ${meta.label}`}
              className="min-w-[150px] flex-1 rounded-2xl border border-border bg-card p-4 active:opacity-80 web:transition web:hover:border-primary"
            >
              <View className="mb-3 h-11 w-11 items-center justify-center rounded-full bg-primary/10">
                <Icon size={22} color={colors.primary} />
              </View>
              <Text className="text-base font-semibold text-foreground">{meta.label}</Text>
              <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={2}>
                {meta.description}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** A recent shipment row (pre-booking: quoting/quoted/cancelled). */
function ShipmentRow({ shipment }: { shipment: Shipment }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const meta = SHIPMENT_TYPES[shipment.type];
  const Icon = meta.icon;
  return (
    <Pressable
      onPress={() => router.push(`/shipments/${shipment.id}/quotes`)}
      className="flex-row items-center gap-3 rounded-2xl border border-border bg-card p-4 active:opacity-80"
    >
      <View className="h-10 w-10 items-center justify-center rounded-full bg-muted">
        <Icon size={18} color={colors.mutedForeground} />
      </View>
      <View className="flex-1 gap-1">
        <View className="flex-row items-center justify-between">
          <Text className="text-sm font-semibold text-foreground">{meta.label}</Text>
          <StatusBadge status={shipment.status} />
        </View>
        <RouteSummary from={shipment.pickup.address.city} to={shipment.dropoff.address.city} />
      </View>
      <ChevronRight size={18} color={colors.mutedForeground} />
    </Pressable>
  );
}

/** A recent job row (booked: requested → delivered). */
function JobRow({ job }: { job: JobSummary }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const meta = SHIPMENT_TYPES[job.type];
  const Icon = meta.icon;
  return (
    <Pressable
      onPress={() => router.push(`/jobs/${job.id}`)}
      className="flex-row items-center gap-3 rounded-2xl border border-border bg-card p-4 active:opacity-80"
    >
      <View className="h-10 w-10 items-center justify-center rounded-full bg-muted">
        <Icon size={18} color={colors.mutedForeground} />
      </View>
      <View className="flex-1 gap-1">
        <View className="flex-row items-center justify-between">
          <Text className="text-sm font-semibold text-foreground">{job.jobNumber}</Text>
          <StatusBadge status={job.status} />
        </View>
        <MoneyText money={job.totals.total} size="sm" />
      </View>
      <ChevronRight size={18} color={colors.mutedForeground} />
    </Pressable>
  );
}

/** The signed-in "recent activity" feed (active jobs + open shipments). */
function RecentActivity() {
  const { data: jobsPage, isLoading: jobsLoading } = useMyJobs({ limit: 5 });
  const { data: shipmentsPage, isLoading: shipmentsLoading } = useMyShipments({ limit: 5 });

  const jobs = jobsPage?.data ?? [];
  // Only show shipments that have NOT been booked yet (booked ones live as jobs).
  const openShipments = (shipmentsPage?.data ?? []).filter(
    (s) => s.status === 'quoting' || s.status === 'quoted',
  );

  const loading = jobsLoading || shipmentsLoading;
  const empty = !loading && jobs.length === 0 && openShipments.length === 0;

  return (
    <View className="px-4 pt-8">
      <Text className="mb-3 text-lg font-bold text-foreground">Your deliveries</Text>
      {loading ? (
        <Text className="py-6 text-center text-sm text-muted-foreground">Loading…</Text>
      ) : empty ? (
        <View className="items-center rounded-2xl border border-dashed border-border bg-card/50 px-6 py-10">
          <Text className="text-sm font-medium text-foreground">No deliveries yet</Text>
          <Text className="mt-1 text-center text-xs text-muted-foreground">
            Your shipments and active jobs will show up here.
          </Text>
        </View>
      ) : (
        <View className="gap-3">
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
          {openShipments.map((shipment) => (
            <ShipmentRow key={shipment.id} shipment={shipment} />
          ))}
        </View>
      )}
    </View>
  );
}

/** The signed-out marketing prompt under the CTA. */
function SignedOutPrompt() {
  return (
    <View className="px-4 pt-8">
      <View className="items-center rounded-2xl border border-dashed border-border bg-card/50 px-6 py-10">
        <Text className="text-sm font-medium text-foreground">Sign in to track your deliveries</Text>
        <Text className="mt-1 text-center text-xs text-muted-foreground">
          Create a shipment above — we'll ask you to sign in to send it.
        </Text>
        <Pressable
          onPress={() => openAccountDialog()}
          accessibilityRole="button"
          className="mt-4 rounded-full bg-primary px-5 py-2.5 active:opacity-90"
        >
          <Text className="text-sm font-semibold text-primary-foreground">Sign in</Text>
        </Pressable>
      </View>
    </View>
  );
}

function HomeBody() {
  const { colors } = useColorScheme();
  const { isAuthenticated } = useOxy();
  return (
    <>
      <View className="items-center bg-background px-4 pb-2 pt-10">
        <MoovoWordmark width={200} color={colors.foreground} />
        <Text className="mt-2 text-sm text-muted-foreground">
          Send packages, food and moves — your way.
        </Text>
      </View>

      <SendCta />
      {isAuthenticated ? <RecentActivity /> : <SignedOutPrompt />}

      <Footer />
    </>
  );
}

export default function HomeScreen() {
  const { colors } = useColorScheme();
  const isWeb = Platform.OS === 'web';

  const head = (
    <Head>
      <title>Moovo</title>
      <meta name="description" content="Moovo — send packages, food and moves." />
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
            <HomeBody />
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
        <HomeBody />
      </ScrollView>
    </View>
  );
}
