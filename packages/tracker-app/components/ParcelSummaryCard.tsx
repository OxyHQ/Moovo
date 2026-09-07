import { Pressable, Text, View } from 'react-native';
import { Link } from 'expo-router';
import type { TrackedParcel } from '@moovo/shared-types';
import { StatusBadge } from '@/components/StatusBadge';
import { formatDate } from '@/lib/status';

/** One row in the signed-in user's list. */
export function ParcelSummaryCard({ parcel }: { parcel: TrackedParcel }) {
  const eta = formatDate(parcel.estimatedDeliveryAt);
  const delivered = formatDate(parcel.deliveredAt);

  return (
    <Link href={`/parcels/${parcel.id}`} asChild>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${parcel.title ?? parcel.trackingNumber}, ${parcel.carrier.name}`}
        className="rounded-2xl border border-border bg-card p-4 active:opacity-70"
      >
        <View className="flex-row items-start justify-between gap-3">
          <View className="flex-1">
            <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
              {parcel.title ?? parcel.trackingNumber}
            </Text>
            <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
              {parcel.carrier.name} · {parcel.trackingNumber}
            </Text>
          </View>
          <StatusBadge status={parcel.status} />
        </View>

        {delivered ? (
          <Text className="mt-3 text-xs text-muted-foreground">Entregado el {delivered}</Text>
        ) : eta ? (
          <Text className="mt-3 text-xs text-muted-foreground">Entrega prevista: {eta}</Text>
        ) : null}
      </Pressable>
    </Link>
  );
}
