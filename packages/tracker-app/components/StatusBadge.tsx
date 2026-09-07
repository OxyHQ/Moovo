import { Text, View } from 'react-native';
import type { TrackingStatus } from '@moovo/shared-types';
import { STATUS_LABELS, statusTone } from '@/lib/status';
import { cn } from '@/lib/utils';

export function StatusBadge({
  status,
  className,
}: {
  status: TrackingStatus;
  className?: string;
}) {
  const tone = statusTone(status);

  return (
    <View className={cn('self-start rounded-full px-3 py-1', tone.chip, className)}>
      <Text className={cn('text-xs font-semibold', tone.text)}>{STATUS_LABELS[status]}</Text>
    </View>
  );
}
