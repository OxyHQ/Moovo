import type { JobStatus, TrackingStatus } from '@moovo/shared-types';

/**
 * Spanish labels for every tracking status.
 *
 * The copy is Spanish because the acquisition channel is: this is the one Moovo
 * surface a stranger reaches without knowing Moovo exists, by searching
 * *rastrear paquete* or *seguimiento de paquete*. `Record<TrackingStatus, …>` is
 * exhaustive on purpose — a status added to `TRACKING_STATUSES` fails the type
 * check here instead of rendering a raw enum value to a customer.
 */
export const STATUS_LABELS: Record<TrackingStatus, string> = {
  pending: 'Pendiente',
  info_received: 'Información recibida',
  in_transit: 'En tránsito',
  out_for_delivery: 'En reparto',
  available_for_pickup: 'Disponible para recoger',
  delivered: 'Entregado',
  failed_attempt: 'Intento fallido',
  exception: 'Incidencia',
  returned: 'Devuelto',
  expired: 'Caducado',
  cancelled: 'Cancelado',
};

/** A short explanation shown under the headline status. */
export const STATUS_HINTS: Record<TrackingStatus, string> = {
  pending: 'Todavía no hemos podido consultar este envío.',
  info_received: 'El transportista ha registrado la etiqueta, pero aún no tiene el paquete.',
  in_transit: 'El paquete va camino de su destino.',
  out_for_delivery: 'El paquete sale hoy a reparto.',
  available_for_pickup: 'El paquete espera en un punto de recogida.',
  delivered: 'El paquete se ha entregado.',
  failed_attempt: 'El transportista intentó entregarlo y no pudo.',
  exception: 'Hay una incidencia con este envío.',
  returned: 'El paquete vuelve al remitente.',
  expired: 'El transportista ya no da información de este envío.',
  cancelled: 'El envío se ha cancelado.',
};

/**
 * The Bloom chip tone per status, grouped by what a reader must DO about it.
 *
 * Four buckets rather than eleven colours: delivered is settled, `exception`,
 * `failed_attempt`, `returned` and `cancelled` need attention,
 * `out_for_delivery` and `available_for_pickup` are the states people open the
 * app for, and the rest are simply in progress.
 */
export function statusColor(status: TrackingStatus): 'primary' | 'success' | 'warning' | 'error' {
  switch (status) {
    case 'delivered':
      return 'success';
    case 'exception':
    case 'failed_attempt':
    case 'returned':
    case 'cancelled':
      return 'error';
    case 'out_for_delivery':
    case 'available_for_pickup':
      return 'warning';
    default:
      return 'primary';
  }
}

/** Whether a status is terminal — nothing more will happen on its own. */
export function isTerminal(status: TrackingStatus): boolean {
  return (
    status === 'delivered' ||
    status === 'returned' ||
    status === 'cancelled' ||
    status === 'expired'
  );
}

/**
 * A checkpoint's time, formatted for display.
 *
 * `occurredAtIsLocal` is honoured rather than ignored: roughly half of carrier
 * APIs report wall-clock time with no offset, so that timestamp is the
 * carrier's local time and NOT a true instant. Rendering it in the device's
 * timezone would shift it by hours and silently reorder a timeline the moment a
 * parcel crosses a border, so a local-time checkpoint is formatted in UTC —
 * which prints the digits the carrier actually reported.
 */
export function formatCheckpointTime(occurredAt: string, occurredAtIsLocal: boolean): string {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('es-ES', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: occurredAtIsLocal ? 'UTC' : undefined,
  }).format(date);
}

/** A date shown on its own (estimated delivery, delivered at). */
export function formatDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(date);
}

/**
 * Spanish labels for a Moovo delivery's OWN lifecycle.
 *
 * Kept separate from {@link STATUS_LABELS} because the two vocabularies are
 * separate: `JobStatus` is a DISPATCH AUCTION (`offered`, `accepted` — Moovo's
 * race between couriers, which no carrier has), and merging it into the parcel
 * vocabulary is exactly what the tracking DTOs refuse to do. A job's headline
 * status still reaches the tracker projected into `TrackingStatus`; this map is
 * only for rendering the delivery's own history rows.
 */
export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  requested: 'Solicitado',
  offered: 'Buscando repartidor',
  accepted: 'Repartidor asignado',
  picked_up: 'Recogido',
  in_transit: 'En camino',
  delivered: 'Entregado',
  cancelled: 'Cancelado',
};
