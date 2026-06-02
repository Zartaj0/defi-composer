"use client";

import { useEffect } from "react";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig } from "./wagmi.config";
import "@rainbow-me/rainbowkit/styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, gcTime: 5 * 60_000, retry: 2 },
  },
});

// Suppress WalletConnect "source not authorized" unhandled rejections.
// These fire when the projectId placeholder is used on an unregistered domain.
// They are non-fatal for the mandate dashboard (read-only, no wallet needed).
function WalletConnectErrorSuppressor() {
  useEffect(() => {
    const handler = (e: PromiseRejectionEvent) => {
      const msg = e.reason?.message ?? String(e.reason ?? "");
      if (msg.includes("not been authorized") || msg.includes("projectId")) {
        e.preventDefault();
      }
    };
    window.addEventListener("unhandledrejection", handler);
    return () => window.removeEventListener("unhandledrejection", handler);
  }, []);
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({
            accentColor: "#6366f1",
            accentColorForeground: "white",
            borderRadius: "medium",
            fontStack: "system",
          })}
          modalSize="compact"
        >
          <WalletConnectErrorSuppressor />
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
