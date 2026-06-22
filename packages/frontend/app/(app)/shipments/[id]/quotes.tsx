import { useState } from 'react';
import { View, ScrollView, Pressable, ActivityIndicator, Platform } from 'react-native';
import Head from 'expo-router/head';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, Clock, Truck, Building2, Check } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { StatusBadge } from '@/components/transport/StatusBadge';
import { MoneyText } from '@/components/transport/MoneyText';
import { RouteSummary } from '@/components/transport/RouteSummary';
import { useColorScheme } from '@/lib/useColorScheme';
import { useShipment, useShipmentQuotes, useBookShipment } from '@/lib/hooks/use-shipments';
import { SHIPMENT_TYPES } from '@/lib/shipment-type';
import type { QuoteView } from '@moovo/shared-types';

/** Poll interval (ms) while the shipment is still being quoted. */
const QUOTE_POLL_MS = 3000;

/** Format an ETA in minutes as a short human string. */
function formatEta(minutes?: number): string | null {
  if (minutes === undefined) {
    return null;
  }
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem ? `${hours}h ${rem}m` : `${hours}h`;
}

/** One selectable quote card (internal Moovo courier or external provider). */
function QuoteCard({
  quote,
  selected,
  booking,
  onSelect,
}: {
  quote: QuoteView;
  selected: boolean;
  booking: boolean;
  onSelect: () => void;
}) {
  const { colors } = useColorScheme();
  const isMoovo = quote.source === 'moovo_courier';
  const SourceIcon = isMoovo ? Truck : Building2;
  const sourceLabel = isMoovo ? 'Moovo courier' : quote.providerName ?? 'External provider';
  const pickupEta = formatEta(quote.etaPickupMin);
  const deliveryEta = formatEta(quote.etaDeliveryMin);

  return (
    <Pressable
      onPress={onSelect}
      disabled={booking}
      accessibilityRole="button"
      className={`rounded-2xl border bg-card p-4 active:opacity-80 ${selected ? 'border-primary' : 'border-border'}`}
    >
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <View className="h-9 w-9 items-center justify-center rounded-full bg-primary/10">
            <SourceIcon size={18} color={colors.primary} />
          </View>
          <View>
            <Text className="text-sm font-semibold text-foreground">{sourceLabel}</Text>
            <Text className="text-xs text-muted-foreground">
              {isMoovo ? 'Fulfilled by Moovo' : 'External delivery partner'}
            </Text>
          </View>
        </View>
        {selected && booking ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : selected ? (
          <View className="h-6 w-6 items-center justify-center rounded-full bg-primary">
            <Check size={14} color={colors.primaryForeground} />
          </View>
        ) : null}
      </View>

      <View className="mt-3 flex-row items-end justify-between">
        <MoneyText money={quote.priceBreakdown.total} size="lg" />
        {pickupEta || deliveryEta ? (
          <View className="items-end gap-0.5">
            {pickupEta ? (
              <View className="flex-row items-center gap-1">
                <Clock size={12} color={colors.mutedForeground} />
                <Text className="text-xs text-muted-foreground">Pickup ~{pickupEta}</Text>
              </View>
            ) : null}
            {deliveryEta ? (
              <Text className="text-xs text-muted-foreground">Delivery ~{deliveryEta}</Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

export default function QuotesScreen() {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { id } = useLocalSearchParams<{ id: string }>();

  const { data: shipment } = useShipment(id);
  const [selectedQuoteId, setSelectedQuoteId] = useState<string | null>(null);
  const [bookError, setBookError] = useState<string | null>(null);
  const book = useBookShipment(id);

  // Keep polling until quotes have arrived (or the shipment left the quoting
  // states). Once `quoted`/`booked`/terminal, stop the interval.
  const stillQuoting = shipment?.status === 'quoting' || shipment === undefined;
  const { data: quoteList, isLoading } = useShipmentQuotes(id, {
    refetchInterval: stillQuoting ? QUOTE_POLL_MS : false,
  });

  const quotes = quoteList?.quotes ?? [];
  const hasQuotes = quotes.length > 0;
  const isBooked = shipment?.status === 'booked';

  const handleBook = async (quoteId: string) => {
    setSelectedQuoteId(quoteId);
    setBookError(null);
    try {
      const result = await book.mutateAsync({ quoteId });
      router.replace(`/jobs/${result.job.id}`);
    } catch (err) {
      setBookError(err instanceof Error ? err.message : 'Could not book this quote.');
    }
  };

  const typeMeta = shipment ? SHIPMENT_TYPES[shipment.type] : null;

  return (
    <View className="flex-1 bg-background">
      <Head>
        <title>Quotes · Moovo</title>
      </Head>

      <View className="border-b border-border px-4 pb-3 pt-4">
        <View className="flex-row items-center gap-3">
          <Pressable
            onPress={() => router.replace('/(app)')}
            accessibilityRole="button"
            hitSlop={8}
            className="p-1"
          >
            <ArrowLeft size={20} color={colors.foreground} />
          </Pressable>
          <Text className="flex-1 text-lg font-bold text-foreground">Choose a quote</Text>
          {shipment ? <StatusBadge status={shipment.status} /> : null}
        </View>
        {shipment ? (
          <View className="mt-3 gap-1">
            {typeMeta ? (
              <Text className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {typeMeta.label}
              </Text>
            ) : null}
            <RouteSummary
              from={shipment.pickup.address.city}
              to={shipment.dropoff.address.city}
            />
          </View>
        ) : null}
      </View>

      <ScrollView className="flex-1" contentContainerClassName="px-4 py-4 pb-24">
        <View className="web:mx-auto web:w-full web:max-w-[640px] gap-3">
          {isBooked ? (
            <View className="items-center rounded-2xl border border-border bg-card px-6 py-8">
              <Text className="text-sm font-medium text-foreground">
                This shipment is already booked.
              </Text>
              {shipment?.jobId ? (
                <Pressable
                  onPress={() => router.replace(`/jobs/${shipment.jobId}`)}
                  className="mt-4 rounded-full bg-primary px-5 py-2.5 active:opacity-90"
                >
                  <Text className="text-sm font-semibold text-primary-foreground">
                    Track delivery
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : !hasQuotes ? (
            <View className="items-center rounded-2xl border border-dashed border-border bg-card/50 px-6 py-12">
              <ActivityIndicator size="small" color={colors.primary} />
              <Text className="mt-3 text-sm font-medium text-foreground">
                {isLoading ? 'Loading quotes…' : 'Finding you the best options…'}
              </Text>
              <Text className="mt-1 text-center text-xs text-muted-foreground">
                Comparing Moovo couriers and delivery partners.
              </Text>
            </View>
          ) : (
            <>
              <Text className="text-xs text-muted-foreground">
                {quotes.length} option{quotes.length === 1 ? '' : 's'} available
              </Text>
              {quotes.map((quote) => (
                <QuoteCard
                  key={quote.id}
                  quote={quote}
                  selected={selectedQuoteId === quote.id}
                  booking={book.isPending && selectedQuoteId === quote.id}
                  onSelect={() => handleBook(quote.id)}
                />
              ))}
            </>
          )}

          {bookError ? (
            <Text className="mt-2 text-center text-sm text-red-600">{bookError}</Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}
