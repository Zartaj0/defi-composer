// RPC transport utility — mirrors simulation-engine/src/rpc-transport.ts
// Kept separate to avoid circular dependency (simulation-engine → protocol-adapters).
import { fallback, http } from "viem";

function loadRpcUrls(): string[] {
  const urls: string[] = [];
  const p = process.env["BASE_RPC_URL"];
  const s = process.env["BASE_RPC_URL_2"];
  if (p) urls.push(p);
  if (s) urls.push(s);
  if (urls.length === 0) urls.push("https://mainnet.base.org");
  return urls;
}

export function createFallbackTransport() {
  const urls = loadRpcUrls();
  if (urls.length === 1) return http(urls[0]);
  return fallback(
    urls.map(url => http(url, { retryCount: 1, retryDelay: 200 })),
    { rank: false }
  );
}
