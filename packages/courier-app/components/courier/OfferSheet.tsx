import { useEffect, useState } from "react";
import { View, Pressable, ActivityIndicator } from "react-native";
import { MapPin, Flag, Clock, Package } from "lucide-react-native";
import type { JobOfferView } from "@moovo/shared-types";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useColorScheme } from "@/lib/useColorScheme";
import { formatDisplayMoney } from "@/lib/money";
import { formatDistance } from "@/lib/geo";

/**
 * Real-time incoming dispatch offer.
 *
 * Rendered as a bottom-anchored card overlay when a `job:offer` arrives over the
 * socket. Shows the job type, pickup→dropoff cities, courier→pickup distance, the
 * FAIR fare (with its converted display amount), and a live countdown to the
 * offer's `expiresAt`. Accept fires the offer-gated accept call; Decline simply
 * dismisses it. When the countdown hits zero the offer auto-dismisses (the
 * backend will have expired it server-side).
 */

/** Countdown tick interval. */
const TICK_MS = 1000;

interface OfferSheetProps {
  /** The live offer to render. */
  offer: JobOfferView;
  /** Whether the accept request is in flight. */
  accepting: boolean;
  /** Accept the offer (offer-gated; the parent handles the CONFLICT case). */
  onAccept: () => void;
  /** Decline / dismiss the offer. */
  onDecline: () => void;
}

/** Seconds remaining until `expiresAt`, clamped at 0. */
function secondsUntil(expiresAt: string): number {
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 1000));
}

export function OfferSheet({ offer, accepting, onAccept, onDecline }: OfferSheetProps) {
  const { colors } = useColorScheme();
  const [remaining, setRemaining] = useState(() => secondsUntil(offer.expiresAt));

  // Tick the countdown each second; auto-decline once it elapses. A timer is an
  // inherently effectful subscription — torn down on unmount / offer change.
  useEffect(() => {
    setRemaining(secondsUntil(offer.expiresAt));
    const id = setInterval(() => {
      const next = secondsUntil(offer.expiresAt);
      setRemaining(next);
      if (next <= 0) {
        clearInterval(id);
        onDecline();
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [offer.expiresAt, onDecline]);

  const fare = formatDisplayMoney(offer.totals.total);

  return (
    <View className="absolute inset-x-0 bottom-0 z-[80] p-3">
      <View className="overflow-hidden rounded-3xl border border-border bg-card p-5 shadow-lg shadow-foreground/20">
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-2">
            <Package size={18} color={colors.primary} />
            <Text className="text-base font-bold capitalize text-foreground">
              New {offer.type} job
            </Text>
          </View>
          <View className="flex-row items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1">
            <Clock size={14} color={colors.primary} />
            <Text className="text-sm font-semibold text-primary">{remaining}s</Text>
          </View>
        </View>

        <View className="mt-4 gap-3">
          <View className="flex-row items-center gap-2">
            <MapPin size={16} color={colors.mutedForeground} />
            <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
              {offer.pickupCity}
            </Text>
          </View>
          <View className="flex-row items-center gap-2">
            <Flag size={16} color={colors.mutedForeground} />
            <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
              {offer.dropoffCity}
            </Text>
          </View>
        </View>

        <View className="mt-4 flex-row items-center justify-between">
          <Text className="text-sm text-muted-foreground">
            {formatDistance(offer.distanceM)} to pickup
          </Text>
          <Text className="text-xl font-bold text-foreground">{fare}</Text>
        </View>

        <View className="mt-5 flex-row gap-3">
          <Pressable
            onPress={onDecline}
            disabled={accepting}
            accessibilityRole="button"
            accessibilityLabel="Decline offer"
            className="h-12 flex-1 items-center justify-center rounded-xl border border-border active:bg-accent web:hover:bg-accent"
          >
            <Text className="text-base font-semibold text-foreground">Decline</Text>
          </Pressable>
          <Button
            onPress={onAccept}
            disabled={accepting}
            size="lg"
            className="h-12 flex-1"
          >
            {accepting ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text className="text-base font-semibold text-primary-foreground">
                Accept
              </Text>
            )}
          </Button>
        </View>
      </View>
    </View>
  );
}
