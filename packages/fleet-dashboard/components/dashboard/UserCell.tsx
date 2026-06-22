import { View } from "react-native";
import { Avatar } from "@oxyhq/bloom/avatar";
import { Text } from "@/components/ui/text";
import { useUserProfile } from "@/lib/hooks/use-user-profile";

interface UserCellProps {
  /** Oxy user id to resolve into a display name + avatar. */
  oxyUserId: string;
  /** Avatar size in px. */
  size?: number;
  /** Optional trailing line (e.g. role) rendered under the username. */
  subtitle?: string;
}

/**
 * An identity cell: avatar + canonical `name.displayName` + `@username`, resolved
 * live from Oxy by `oxyUserId`. Per the identity contract, the display name is
 * `user.name.displayName` rendered directly — never recomposed locally. The
 * avatar passes the Oxy file id to Bloom's `source` so the app's ImageResolver
 * resolves it via the media CDN.
 */
export function UserCell({ oxyUserId, size = 36, subtitle }: UserCellProps) {
  const { data: user, isPending } = useUserProfile(oxyUserId);

  const displayName = user?.name.displayName ?? "";
  const username = user?.username;

  return (
    <View className="min-w-0 flex-row items-center gap-3">
      <Avatar
        source={user?.avatar ?? undefined}
        name={displayName || username}
        size={size}
      />
      <View className="min-w-0 flex-1">
        <Text
          className="text-sm font-semibold text-surface-foreground"
          numberOfLines={1}
        >
          {isPending ? "…" : displayName || oxyUserId}
        </Text>
        {subtitle ? (
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : username ? (
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            @{username}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
