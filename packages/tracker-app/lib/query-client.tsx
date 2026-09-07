import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A parcel's checkpoints change on the poller's schedule, not on ours.
      staleTime: 1000 * 60,
      gcTime: 1000 * 60 * 30,
      retry: 1,
      refetchOnWindowFocus: true,
    },
    mutations: {
      // NOT retried. Every mutation here is non-idempotent from the client's
      // side: a DELETE whose response is lost has already removed the
      // subscription, so the retry answers 404 and the user is told their
      // successful deletion failed. Same shape for the 202 refresh, which the
      // server rate-limits on a cooldown.
      retry: 0,
    },
  },
});

export function QueryProvider({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

export { queryClient };
