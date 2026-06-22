import { View } from 'react-native';
import { Image } from 'expo-image';
import { useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import { Text } from '@/components/ui/text';

/**
 * The assigned courier's identity card on the tracking screen.
 *
 * `JobView` exposes only `courierOxyUserId`; identity (display name + avatar) is
 * resolved live from Oxy via `getUserById` (a TanStack Query, not an effect).
 * Per the display-name contract we render `name.displayName` directly — no local
 * `displayName || username` fallback chain beyond the SDK's own absence. The Oxy
 * file-id avatar is resolved through the SDK's media chokepoint.
 */
export function CourierInfo({ courierOxyUserId }: { courierOxyUserId: string }) {
  const { oxyServices, isAuthenticated } = useOxy();

  const { data: courier } = useQuery({
    queryKey: ['oxy-user', courierOxyUserId],
    queryFn: () => oxyServices.getUserById(courierOxyUserId),
    enabled: isAuthenticated && Boolean(courierOxyUserId),
    staleTime: 5 * 60 * 1000,
  });

  // Render the canonical display name directly; a generic placeholder is used
  // only while the courier profile is still loading.
  const displayName = courier ? courier.name.displayName : 'Your courier';
  const avatarUrl = courier?.avatar
    ? oxyServices.getFileDownloadUrl(courier.avatar, 'thumb')
    : null;
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-card p-4">
      <View className="h-12 w-12 items-center justify-center overflow-hidden rounded-full bg-muted">
        {avatarUrl ? (
          <Image
            source={{ uri: avatarUrl }}
            style={{ width: 48, height: 48 }}
            contentFit="cover"
            transition={150}
          />
        ) : (
          <Text className="text-lg font-bold text-foreground">{initial}</Text>
        )}
      </View>
      <View className="flex-1">
        <Text className="text-xs text-muted-foreground">Your courier</Text>
        <Text className="text-base font-semibold text-foreground">{displayName}</Text>
        {courier?.username ? (
          <Text className="text-xs text-muted-foreground">@{courier.username}</Text>
        ) : null}
      </View>
    </View>
  );
}
