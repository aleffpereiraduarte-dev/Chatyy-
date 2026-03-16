import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60000, // 1 min
      cacheTime: 300000, // 5 min
      retry: 2,
      refetchOnWindowFocus: true,
    },
  },
});
