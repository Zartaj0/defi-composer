import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { mainnet, base, baseSepolia } from "wagmi/chains";
import { defineChain, http } from "viem";

// WalletConnect project ID — set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID in .env
const projectId =
  process.env["NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID"] ?? "606c14e6417fd9a07477068b05e1d3a2";

// ── contract.dev Stagenet ─────────────────────────────────────────────────────
// A private EVM testnet that mirrors Ethereum mainnet state (same contract
// addresses, same balances) but lets you set balances and impersonate accounts.
// Chain ID: 52638  RPC: https://rpc.contract.dev/<your-key>
// Set NEXT_PUBLIC_STAGENET_RPC_URL in .env.local to enable it in the chain picker.
const stagenetRpcUrl = process.env["NEXT_PUBLIC_STAGENET_RPC_URL"] ?? "";

export const contractDevStagenet = defineChain({
  id: 52638,
  name: "Ethereum (contract.dev)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [stagenetRpcUrl || "https://rpc.contract.dev/775c3bd2d7a94c2e426551614d6de126"] },
    public:  { http: [stagenetRpcUrl || "https://rpc.contract.dev/775c3bd2d7a94c2e426551614d6de126"] },
  },
  blockExplorers: {
    default: { name: "Etherscan", url: "https://etherscan.io" },
  },
  testnet: true,
});

// ── Local Anvil fork ──────────────────────────────────────────────────────────
// Set NEXT_PUBLIC_FORK_RPC_URL=http://127.0.0.1:8545 to use a local Anvil fork.
const forkRpcUrl = process.env["NEXT_PUBLIC_FORK_RPC_URL"] ?? "";

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

// ── Chain set ─────────────────────────────────────────────────────────────────
// Priority: local fork > stagenet > live chains
const isForkMode    = Boolean(forkRpcUrl);
const isStagenet    = Boolean(stagenetRpcUrl) || !isForkMode; // stagenet always available

// ── Reliable public RPC transports ───────────────────────────────────────────
// Avoids wagmi's default eth.merkle.io transport which is heavily rate-limited.
// Cloudflare and base.org public endpoints have no CORS or rate-limit issues.
export const wagmiConfig = isForkMode
  ? getDefaultConfig({
      appName: "DeFi Composer",
      projectId,
      chains: [baseFork],
      ssr: true,
      transports: {
        [baseFork.id]: http(forkRpcUrl || "http://127.0.0.1:8545"),
      },
    })
  : getDefaultConfig({
      appName: "DeFi Composer",
      projectId,
      chains: [contractDevStagenet, mainnet, base, baseSepolia],
      ssr: true,
      transports: {
        [contractDevStagenet.id]: http(stagenetRpcUrl || "https://rpc.contract.dev/775c3bd2d7a94c2e426551614d6de126"),
        [mainnet.id]:    http("https://cloudflare-eth.com"),
        [base.id]:       http("https://mainnet.base.org"),
        [baseSepolia.id]: http("https://sepolia.base.org"),
      },
    });
