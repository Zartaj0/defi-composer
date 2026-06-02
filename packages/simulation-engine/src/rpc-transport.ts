// ============================================================
// RPC Transport Utilities
//
// Reads chain-appropriate RPC URLs from env:
//   CHAIN_ID=84532  → BASE_SEPOLIA_RPC_URL (falls back to https://sepolia.base.org)
//   CHAIN_ID=8453   → BASE_RPC_URL + BASE_RPC_URL_2 (Alchemy mainnet, round-robin)
//
// Provides:
//   - createFallbackTransport()  — viem fallback([primary, secondary])
//   - getNextForkUrl()           — round-robin URL for Anvil fork spawning
// ============================================================

import { fallback, http } from "viem";

function getChainId(): number {
  return parseInt(process.env["CHAIN_ID"] ?? "8453", 10);
}

function loadRpcUrls(): string[] {
  const urls: string[] = [];
  if (getChainId() === 84532) {
    // Base Sepolia — use dedicated Sepolia RPC
    const sepoliaUrl = process.env["BASE_SEPOLIA_RPC_URL"] ?? "https://sepolia.base.org";
    urls.push(sepoliaUrl);
  } else {
    // Base mainnet — Alchemy keys with fallback
    const primary   = process.env["BASE_RPC_URL"];
    const secondary = process.env["BASE_RPC_URL_2"];
    if (primary)   urls.push(primary);
    if (secondary) urls.push(secondary);
    if (urls.length === 0) urls.push("https://mainnet.base.org");
  }
  return urls;
}

// Exported so other packages can read the URL list
export function getRpcUrls(): string[] {
  return loadRpcUrls();
}

// Round-robin counter for Anvil fork URL selection.
// Each fork session picks a different key to spread load.
let _forkCounter = 0;
export function getNextForkUrl(): string {
  const urls = loadRpcUrls();
  const url  = urls[_forkCounter % urls.length]!;
  _forkCounter++;
  return url;
}

// viem fallback transport — automatically retries secondary on 429/error.
// Use this for all read-only viem clients (protocol adapters, monitor, etc.)
export function createFallbackTransport() {
  const urls = loadRpcUrls();
  if (urls.length === 1) {
    return http(urls[0]);
  }
  return fallback(
    urls.map(url => http(url, {
      retryCount: 1,
      retryDelay: 200,
    })),
    { rank: false }   // don't rank — just failover in order
  );
}
