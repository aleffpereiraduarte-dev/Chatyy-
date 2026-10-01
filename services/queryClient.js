import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60000, // 1 min
      gcTime: 300000, // 5 min (was `cacheTime` — a no-op name in React Query v5)
      retry: 2,
      // Global default OFF: `true` refetched every active query on every window/
      // app focus (a refetch-storm, worst on web). Queries that truly need
      // focus-refetch can opt in individually with refetchOnWindowFocus: true.
      refetchOnWindowFocus: false,
    },
  },
});
