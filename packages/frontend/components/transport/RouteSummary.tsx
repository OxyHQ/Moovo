import { View } from 'react-native';
import { ArrowRight, MapPin } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { useColorScheme } from '@/lib/useColorScheme';
import { cn } from '@/lib/utils';

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
  const { colors } = useColorScheme();
  return (
    <View className={cn('flex-row items-center gap-1.5', className)}>
      <MapPin size={14} color={colors.mutedForeground} />
      <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
        {from}
      </Text>
      <ArrowRight size={14} color={colors.mutedForeground} />
      <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
        {to}
      </Text>
    </View>
  );
}
