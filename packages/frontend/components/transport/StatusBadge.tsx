import type { JobStatus, ShipmentStatus } from '@moovo/shared-types';
import { Chip } from '@oxy.so/bloom/chip';

/** A shipment or job status as a Bloom chip: one label and one tone per status, so every list row, header and tracking screen reads the same. */

type AnyStatus = ShipmentStatus | JobStatus;
type ChipColor = 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info';

const STATUS: Record<AnyStatus, { label: string; color: ChipColor }> = {
  // Shipment lifecycle.
  draft: { label: 'Draft', color: 'default' },
  quoting: { label: 'Getting quotes', color: 'warning' },
  quoted: { label: 'Quotes ready', color: 'info' },
  booked: { label: 'Booked', color: 'primary' },
  expired: { label: 'Expired', color: 'default' },
  // Job lifecycle.
  requested: { label: 'Requested', color: 'warning' },
  offered: { label: 'Finding courier', color: 'warning' },
  accepted: { label: 'Courier assigned', color: 'info' },
  picked_up: { label: 'Picked up', color: 'info' },
  in_transit: { label: 'On its way', color: 'info' },
  delivered: { label: 'Delivered', color: 'success' },
  // Shared terminal.
  cancelled: { label: 'Cancelled', color: 'error' },
};

export function StatusBadge({ status }: { status: AnyStatus }) {
  const { label, color } = STATUS[status];
  return (
    <Chip variant="subtle" color={color}>
      {label}
    </Chip>
  );
}
