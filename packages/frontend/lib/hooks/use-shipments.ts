import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import type {
  Shipment,
  ShipmentQuery,
  CreateShipmentInput,
  QuoteList,
  BookShipmentInput,
  BookResult,
  PaginatedResponse,
} from '@moovo/shared-types';
import {
  createShipment,
  fetchMyShipments,
  fetchShipment,
  fetchShipmentQuotes,
  bookShipment,
  cancelShipment,
} from '@/lib/api/shipments';
import { queryKeys } from '@/lib/hooks/query-keys';

/**
 * TanStack Query hooks for the shipment lifecycle.
 *
 * All reads gate on `isAuthenticated` so anonymous visitors never fire an
 * unauthorized request. The quotes query polls while the shipment is still being
 * quoted (the caller passes a `refetchInterval`). Mutations invalidate the
 * affected caches so lists/detail stay fresh after create/book/cancel.
 */

/** List the caller's shipments (paginated). */
export function useMyShipments(query: ShipmentQuery = {}) {
  const { isAuthenticated } = useOxy();
  return useQuery<PaginatedResponse<Shipment>>({
    queryKey: queryKeys.shipments.list(query),
    queryFn: () => fetchMyShipments(query),
    enabled: isAuthenticated,
  });
}

/** Fetch a single shipment. */
export function useShipment(id: string | undefined) {
  const { isAuthenticated } = useOxy();
  return useQuery<Shipment>({
    queryKey: queryKeys.shipments.detail(id ?? ''),
    queryFn: () => fetchShipment(id ?? ''),
    enabled: isAuthenticated && Boolean(id),
  });
}

/**
 * Poll the quotes for a shipment. `refetchInterval` lets the quotes screen poll
 * while quoting is in progress and stop once quotes have arrived.
 */
export function useShipmentQuotes(
  id: string | undefined,
  options?: Pick<UseQueryOptions<QuoteList>, 'refetchInterval'>,
) {
  const { isAuthenticated } = useOxy();
  return useQuery<QuoteList>({
    queryKey: queryKeys.shipments.quotes(id ?? ''),
    queryFn: () => fetchShipmentQuotes(id ?? ''),
    enabled: isAuthenticated && Boolean(id),
    refetchInterval: options?.refetchInterval,
  });
}

/** Create a shipment. */
export function useCreateShipment() {
  const queryClient = useQueryClient();
  return useMutation<Shipment, Error, CreateShipmentInput>({
    mutationFn: createShipment,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.shipments.all });
    },
  });
}

/** Book a quote on a shipment (creates the job). */
export function useBookShipment(shipmentId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation<BookResult, Error, BookShipmentInput>({
    mutationFn: (input) => bookShipment(shipmentId ?? '', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.shipments.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
    },
  });
}

/** Cancel a shipment. */
export function useCancelShipment() {
  const queryClient = useQueryClient();
  return useMutation<Shipment, Error, string>({
    mutationFn: cancelShipment,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.shipments.all });
    },
  });
}
