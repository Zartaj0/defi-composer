"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// QueryClient lives outside the component so it isn't recreated on re-renders.
// WalletConnect/RainbowKit is intentionally excluded here — the mandate dashboard
// is read-only. Wallet connection can be added back per-page when needed.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,   // 30s
      gcTime: 5 * 60_000,  // 5min cache
      retry: 2,
    },
  },
});

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}
