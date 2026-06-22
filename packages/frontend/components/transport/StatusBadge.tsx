import { View } from 'react-native';
import type { JobStatus, ShipmentStatus } from '@moovo/shared-types';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * A compact pill rendering a shipment or job status with a semantic color.
 *
 * One mapping per status (label + Tailwind color classes) so list rows, headers
 * and the tracking screen all read the same copy/colors. Colors are NativeWind
 * utility classes (no inline styles, no hardcoded hex).
 */

type AnyStatus = ShipmentStatus | JobStatus;

interface StatusStyle {
  label: string;
  /** Background + text classes for the pill. */
  classes: string;
}

const STATUS_STYLES: Record<AnyStatus, StatusStyle> = {
  // Shipment lifecycle.
  draft: { label: 'Draft', classes: 'bg-muted text-muted-foreground' },
  quoting: { label: 'Getting quotes', classes: 'bg-amber-500/15 text-amber-600' },
  quoted: { label: 'Quotes ready', classes: 'bg-blue-500/15 text-blue-600' },
  booked: { label: 'Booked', classes: 'bg-violet-500/15 text-violet-600' },
  expired: { label: 'Expired', classes: 'bg-muted text-muted-foreground' },
  // Job lifecycle.
  requested: { label: 'Requested', classes: 'bg-amber-500/15 text-amber-600' },
  offered: { label: 'Finding courier', classes: 'bg-amber-500/15 text-amber-600' },
  accepted: { label: 'Courier assigned', classes: 'bg-blue-500/15 text-blue-600' },
  picked_up: { label: 'Picked up', classes: 'bg-blue-500/15 text-blue-600' },
  in_transit: { label: 'On its way', classes: 'bg-blue-500/15 text-blue-600' },
  delivered: { label: 'Delivered', classes: 'bg-green-500/15 text-green-600' },
  // Shared terminal.
  cancelled: { label: 'Cancelled', classes: 'bg-red-500/15 text-red-600' },
};

export function StatusBadge({ status, className }: { status: AnyStatus; className?: string }) {
  const style = STATUS_STYLES[status];
  return (
    <View className={cn('self-start rounded-full px-2.5 py-1', style.classes, className)}>
      <Text className={cn('text-xs font-semibold', style.classes)}>{style.label}</Text>
    </View>
  );
}
