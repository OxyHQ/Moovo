import { useState } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import Head from 'expo-router/head';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { RiBuilding2Line } from '@oxy.so/bloom/icons/RiBuilding2Line';
import { RiCheckLine } from '@oxy.so/bloom/icons/RiCheckLine';
import { RiTimeLine } from '@oxy.so/bloom/icons/RiTimeLine';
import { RiTruckLine } from '@oxy.so/bloom/icons/RiTruckLine';
import { Loading } from '@oxy.so/bloom/loading';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Text } from '@oxy.so/bloom/typography';
import { StatusBadge } from '@/components/transport/StatusBadge';
import { MoneyText } from '@/components/transport/MoneyText';
import { RouteSummary } from '@/components/transport/RouteSummary';
import { useTheme } from '@oxy.so/bloom/theme';
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
  const { colors } = useTheme();
  const isMoovo = quote.source === 'moovo_courier';
  const SourceIcon = isMoovo ? RiTruckLine : RiBuilding2Line;
  const sourceLabel = isMoovo ? 'Moovo courier' : (quote.providerName ?? 'External provider');
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
            <SourceIcon width={18} fill={colors.primary} />
          </View>
          <View>
            <Text className="text-sm font-semibold text-foreground">{sourceLabel}</Text>
            <Text className="text-xs text-muted-foreground">
              {isMoovo ? 'Fulfilled by Moovo' : 'External delivery partner'}
            </Text>
          </View>
        </View>
        {selected && booking ? (
          <Loading variant="spinner" size="sm" />
        ) : selected ? (
          <View className="h-6 w-6 items-center justify-center rounded-full bg-primary">
            <RiCheckLine width={14} height={14} fill={colors.primaryForeground} />
          </View>
        ) : null}
      </View>

      <View className="mt-3 flex-row items-end justify-between">
        <MoneyText money={quote.priceBreakdown.total} size="lg" />
        {pickupEta || deliveryEta ? (
          <View className="items-end gap-0.5">
            {pickupEta ? (
              <View className="flex-row items-center gap-1">
                <RiTimeLine width={12} fill={colors.textSecondary} />
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

      <PageHeader
        presentation="bar"
        title="Choose a quote"
        subtitle={typeMeta?.label}
        onBack={() => router.replace('/(app)')}
        actions={shipment ? <StatusBadge status={shipment.status} /> : undefined}
      />
      {shipment ? (
        <View className="px-4 pb-2">
          <RouteSummary from={shipment.pickup.address.city} to={shipment.dropoff.address.city} />
        </View>
      ) : null}

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
              <Loading variant="spinner" size="sm" />
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
