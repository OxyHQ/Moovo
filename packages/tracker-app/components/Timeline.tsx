import { Text, View } from 'react-native';
import type { TrackingCheckpoint } from '@moovo/shared-types';
import { STATUS_LABELS, formatCheckpointTime } from '@/lib/status';

/**
 * A parcel's checkpoints, newest first.
 *
 * The API returns them in the order the carrier reported; this reverses to
 * newest-first for display because the question people open the app with is
 * "where is it now", not "where did it start".
 */
export function Timeline({ checkpoints }: { checkpoints: TrackingCheckpoint[] }) {
  if (checkpoints.length === 0) {
    return (
      <View className="rounded-2xl border border-border bg-card p-5">
        <Text className="text-sm text-muted-foreground">
          El transportista todavía no ha registrado ningún movimiento de este envío.
        </Text>
      </View>
    );
  }

  const newestFirst = [...checkpoints].reverse();

  return (
    <View className="rounded-2xl border border-border bg-card p-5">
      {newestFirst.map((checkpoint, index) => {
        const isLatest = index === 0;
        const isLast = index === newestFirst.length - 1;

        return (
          <View key={checkpoint.id} className="flex-row gap-3">
            {/* Rail: the dot for this event, plus the line down to the next. */}
            <View className="items-center">
              <View
                className={
                  isLatest
                    ? 'mt-1.5 h-3 w-3 rounded-full bg-primary'
                    : 'mt-1.5 h-3 w-3 rounded-full border-2 border-border bg-transparent'
                }
              />
              {!isLast && <View className="w-px flex-1 bg-border" />}
            </View>

            <View className={isLast ? 'flex-1 pb-0' : 'flex-1 pb-6'}>
              <Text className="text-sm font-semibold text-foreground">
                {STATUS_LABELS[checkpoint.status]}
              </Text>

              {checkpoint.description ? (
                <Text className="mt-0.5 text-sm text-muted-foreground">
                  {checkpoint.description}
                </Text>
              ) : null}

              <View className="mt-1 flex-row flex-wrap items-center gap-x-2">
                <Text className="text-xs text-muted-foreground">
                  {formatCheckpointTime(checkpoint.occurredAt, checkpoint.occurredAtIsLocal)}
                </Text>
                {checkpoint.locationText ? (
                  <>
                    <Text className="text-xs text-muted-foreground">·</Text>
                    <Text className="text-xs text-muted-foreground">
                      {checkpoint.locationText}
                    </Text>
                  </>
                ) : null}
              </View>
            </View>
          </View>
        );
      })}
    </View>
  );
}
