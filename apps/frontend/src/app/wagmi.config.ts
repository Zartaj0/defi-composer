import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { base, baseSepolia } from "wagmi/chains";

// WalletConnect project ID — set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID in .env
// Get one free at https://cloud.walletconnect.com
// Falls back to a placeholder that disables WalletConnect wallet options.
const projectId =
  process.env["NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID"] ?? "606c14e6417fd9a07477068b05e1d3a2";

export const wagmiConfig = getDefaultConfig({
  appName: "DeFi Composer",
  projectId,
  chains: [base, baseSepolia],
  ssr: true,
});
