import { Chip } from '@oxy.so/bloom/chip';
import type { TrackingStatus } from '@moovo/shared-types';
import { STATUS_LABELS, statusColor } from '@/lib/status';

export function StatusBadge({ status, className }: { status: TrackingStatus; className?: string }) {
  return (
    <Chip variant="subtle" color={statusColor(status)} className={className}>
      {STATUS_LABELS[status]}
    </Chip>
  );
}
