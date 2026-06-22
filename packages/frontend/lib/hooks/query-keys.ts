import type { ShipmentQuery } from '@moovo/shared-types';
import type { JobQuery } from '@/lib/api/jobs';

/**
 * Centralized TanStack Query keys.
 *
 * One factory per domain so cache reads/invalidations agree on the exact key
 * tuples. Transport keys cover the customer's shipment → quotes → booking → job
 * lifecycle.
 */
export const queryKeys = {
  notifications: {
    all: ['notifications'] as const,
  },
  shipments: {
    all: ['shipments'] as const,
    list: (query?: ShipmentQuery) => ['shipments', 'list', query ?? {}] as const,
    detail: (id: string) => ['shipments', 'detail', id] as const,
    quotes: (id: string) => ['shipments', id, 'quotes'] as const,
  },
  jobs: {
    all: ['jobs'] as const,
    list: (query?: JobQuery) => ['jobs', 'list', query ?? {}] as const,
    detail: (id: string) => ['jobs', 'detail', id] as const,
  },
} as const;
