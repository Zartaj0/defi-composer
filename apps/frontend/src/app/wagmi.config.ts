import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { base } from "wagmi/chains";
import { defineChain } from "viem";

// WalletConnect project ID — set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID in .env
// Get one free at https://cloud.walletconnect.com
const projectId =
  process.env["NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID"] ?? "defi-composer-dev";

// Local Base fork chain — used when FORK_RPC_URL env var is set.
// Connects the UI to a locally-running Anvil/Hardhat fork at port 18100.
export const baseFork = defineChain({
  id: 8453,
  name: "Base Fork (Local)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["http://127.0.0.1:18100"] },
    public: { http: ["http://127.0.0.1:18100"] },
  },
  testnet: true,
});

// When FORK_RPC_URL is set, prefer the fork chain first so wagmi routes
// all RPC calls to the local node. Otherwise use Base mainnet only.
const isForkMode =
  typeof process !== "undefined" &&
  (process.env["FORK_RPC_URL"] !== undefined ||
    process.env["NEXT_PUBLIC_FORK_MODE"] === "true");

export const wagmiConfig = getDefaultConfig({
  appName: "DeFi Composer",
  appDescription:
    "Autonomous treasury OS for DAOs. Define your goal, we compose and manage the optimal DeFi strategy.",
  projectId,
  chains: isForkMode ? [baseFork, base] : [base],
  ssr: true, // required for Next.js App Router
});
