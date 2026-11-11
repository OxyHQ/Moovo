import { View } from 'react-native';
import { RiArrowRightLine } from '@oxy.so/bloom/icons/RiArrowRightLine';
import { RiMapPinLine } from '@oxy.so/bloom/icons/RiMapPinLine';
import { Text } from '@oxy.so/bloom/typography';
import { useTheme } from '@oxy.so/bloom/theme';
import { cn } from '@moovo/app-shell/lib/utils';

/**
 * A compact "from → to" route line for list rows and headers.
 *
 * Shows the two endpoint labels (typically the pickup/dropoff city or line1)
 * with a directional arrow between them. Long labels truncate to one line each.
 */
export function RouteSummary({
  from,
  to,
  className,
}: {
  from: string;
  to: string;
  className?: string;
}) {
  const { colors } = useTheme();
  return (
    <View className={cn('flex-row items-center gap-1.5', className)}>
      <RiMapPinLine width={14} height={14} fill={colors.textSecondary} />
      <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
        {from}
      </Text>
      <RiArrowRightLine width={14} height={14} fill={colors.textSecondary} />
      <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
        {to}
      </Text>
    </View>
  );
}
