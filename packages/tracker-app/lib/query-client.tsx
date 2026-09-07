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
      retry: 1,
    },
  },
});

export function QueryProvider({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

export { queryClient };
