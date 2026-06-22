import { View } from "react-native";
import { Text } from "@/components/ui/text";

interface BarRowProps {
  /** Row label. */
  label: string;
  /** This row's value. */
  value: number;
  /** The max value across the chart group, used to scale the bar width. */
  max: number;
}

/**
 * A single horizontal bar built from plain views (no chart dependency): a label,
 * a proportional fill, and the numeric value. The fill width is a percentage of
 * the group max so bars are comparable within a group.
 */
export function BarRow({ label, value, max }: BarRowProps) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <View className="gap-1.5 py-1.5">
      <View className="flex-row items-center justify-between">
        <Text className="text-sm text-surface-foreground" numberOfLines={1}>
          {label}
        </Text>
        <Text className="text-sm font-semibold text-surface-foreground">
          {value}
        </Text>
      </View>
      <View className="h-2 overflow-hidden rounded-full bg-muted">
        {/* Width is a runtime percentage from data — no static class can encode
            an arbitrary percent, so an inline width is the correct tool here. */}
        <View
          className="h-full rounded-full bg-primary"
          style={{ width: `${pct}%` }}
        />
      </View>
    </View>
  );
}
