import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { base, baseSepolia } from "wagmi/chains";
import { defineChain } from "viem";

// WalletConnect project ID — set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID in .env
// Get one free at https://cloud.walletconnect.com
const projectId =
  process.env["NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID"] ?? "606c14e6417fd9a07477068b05e1d3a2";

// Fork mode: set NEXT_PUBLIC_FORK_RPC_URL=http://127.0.0.1:8545 in .env.local
// to point the app at a local Anvil fork instead of live chains.
const forkRpcUrl =
  process.env["NEXT_PUBLIC_FORK_RPC_URL"] ?? "";

export const baseFork = defineChain({
  id: 8453,
  name: "Base Fork (Local)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [forkRpcUrl || "http://127.0.0.1:8545"] },
    public:  { http: [forkRpcUrl || "http://127.0.0.1:8545"] },
  },
  testnet: true,
});

const isForkMode = Boolean(forkRpcUrl);

export const wagmiConfig = isForkMode
  ? getDefaultConfig({
      appName: "DeFi Composer",
      projectId,
      chains: [baseFork],
      ssr: true,
    })
  : getDefaultConfig({
      appName: "DeFi Composer",
      projectId,
      chains: [base, baseSepolia],
      ssr: true,
    });
