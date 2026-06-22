import { View } from 'react-native';
import type { JobStatus, JobStatusEvent } from '@moovo/shared-types';
import { Check } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { useColorScheme } from '@/lib/useColorScheme';
import { cn } from '@/lib/utils';

/**
 * A vertical job-progress timeline (requested → … → delivered).
 *
 * Steps before/at the current status are "done"; the rest are pending. The most
 * recent matching `statusHistory` entry supplies each completed step's timestamp.
 * A cancelled job collapses to a single terminal "Cancelled" row. The current
 * status comes from the authoritative `JobView`; socket lifecycle events refetch
 * it, so this stays in sync without holding its own state.
 */

/** Ordered happy-path steps shown in the timeline. */
const STEPS: { status: JobStatus; label: string }[] = [
  { status: 'requested', label: 'Booked' },
  { status: 'accepted', label: 'Courier assigned' },
  { status: 'picked_up', label: 'Picked up' },
  { status: 'in_transit', label: 'On its way' },
  { status: 'delivered', label: 'Delivered' },
];

/** Map a status to its index in the happy path (`offered` collapses to booked). */
function stepIndex(status: JobStatus): number {
  if (status === 'offered') {
    return 0;
  }
  const idx = STEPS.findIndex((s) => s.status === status);
  return idx >= 0 ? idx : 0;
}

/** Format an ISO time as a short local time string. */
function shortTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    day: 'numeric',
    month: 'short',
  });
}

export function StatusTimeline({
  status,
  history,
}: {
  status: JobStatus;
  history: JobStatusEvent[];
}) {
  const { colors } = useColorScheme();

  if (status === 'cancelled') {
    const cancelledAt = history.find((h) => h.status === 'cancelled')?.at;
    return (
      <View className="rounded-2xl border border-border bg-card p-4">
        <Text className="text-sm font-semibold text-red-600">Cancelled</Text>
        {cancelledAt ? (
          <Text className="mt-1 text-xs text-muted-foreground">{shortTime(cancelledAt)}</Text>
        ) : null}
      </View>
    );
  }

  const currentIndex = stepIndex(status);

  return (
    <View className="rounded-2xl border border-border bg-card p-4">
      {STEPS.map((step, index) => {
        const done = index <= currentIndex;
        const isCurrent = index === currentIndex;
        const at = history.find((h) => h.status === step.status)?.at;
        const isLast = index === STEPS.length - 1;
        return (
          <View key={step.status} className="flex-row">
            {/* Rail: dot + connector line. */}
            <View className="mr-3 items-center">
              <View
                className={cn(
                  'h-6 w-6 items-center justify-center rounded-full',
                  done ? 'bg-primary' : 'bg-muted',
                )}
              >
                {done ? <Check size={14} color={colors.primaryForeground} /> : null}
              </View>
              {!isLast ? (
                <View
                  className={cn('w-0.5 flex-1', done ? 'bg-primary' : 'bg-border')}
                  style={{ minHeight: 24 }}
                />
              ) : null}
            </View>
            {/* Label + timestamp. */}
            <View className={cn('flex-1', isLast ? 'pb-0' : 'pb-4')}>
              <Text
                className={cn(
                  'text-sm',
                  isCurrent ? 'font-bold text-foreground' : done ? 'font-medium text-foreground' : 'text-muted-foreground',
                )}
              >
                {step.label}
              </Text>
              {at ? <Text className="mt-0.5 text-xs text-muted-foreground">{shortTime(at)}</Text> : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}
