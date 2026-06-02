import { createConfig, http } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";

// Minimal wagmi config — HTTP transport only, no WalletConnect required.
// The mandate dashboard is read-only; wallet connection can be added back
// per-page when needed with a real WalletConnect projectId.
export const wagmiConfig = createConfig({
  chains: [base, baseSepolia],
  transports: {
    [base.id]: http(),
    [baseSepolia.id]: http(),
  },
  ssr: true,
});
