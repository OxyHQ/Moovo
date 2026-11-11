import { View } from 'react-native';
import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import { Text } from '@oxy.so/bloom/typography';
import { Card } from '@oxy.so/bloom/card';
import { useTheme } from '@oxy.so/bloom/theme';

interface StatCardProps {
  /** Short metric label. */
  label: string;
  /** The primary value, pre-formatted. */
  value: string;
  /** Optional secondary caption under the value. */
  caption?: string;
  /** Leading icon. */
  icon: BloomIconComponent;
  /** Whether the value/icon is still loading (renders a placeholder dash). */
  loading?: boolean;
}

/**
 * A single KPI tile — a labelled metric with a leading icon. Used on the home
 * overview and the stats screen. Pure presentation; the caller formats values.
 */
export function StatCard({ label, value, caption, icon: Icon, loading = false }: StatCardProps) {
  const { colors } = useTheme();
  return (
    <Card className="min-w-0 flex-1 gap-3 p-4">
      <View className="flex-row items-center justify-between gap-2">
        <Text
          className="min-w-0 flex-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
          numberOfLines={1}
        >
          {label}
        </Text>
        <View className="h-8 w-8 items-center justify-center rounded-full bg-primary/10">
          <Icon width={16} fill={colors.primary} />
        </View>
      </View>
      <Text className="text-2xl font-bold text-surface-foreground" numberOfLines={1}>
        {loading ? '—' : value}
      </Text>
      {caption ? (
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {caption}
        </Text>
      ) : null}
    </Card>
  );
}
