export { AaveV3Adapter } from "./protocols/aave-v3.js";
export { MorphoBlueAdapter } from "./protocols/morpho-blue.js";
export type {
  IProtocolAdapter,
  ProtocolMarket,
  ProtocolPool,
  ProtocolCapabilities,
  EncodedAction,
} from "./types/adapter.js";

// ─── Protocol Registry ───────────────────────────────────────
// Central registry — the Protocol Intelligence Layer's public API
import { AaveV3Adapter } from "./protocols/aave-v3.js";
import { MorphoBlueAdapter } from "./protocols/morpho-blue.js";
import type { IProtocolAdapter } from "./types/adapter.js";
import type { ProtocolName } from "@defi-composer/shared";

export class ProtocolRegistry {
  private adapters: Map<ProtocolName, IProtocolAdapter> = new Map();

  constructor() {
    this.register(new AaveV3Adapter());
    this.register(new MorphoBlueAdapter());
  }

  private register(adapter: IProtocolAdapter): void {
    this.adapters.set(adapter.protocol, adapter);
  }

  get(protocol: ProtocolName): IProtocolAdapter {
    const adapter = this.adapters.get(protocol);
    if (!adapter) throw new Error(`No adapter registered for protocol: ${protocol}`);
    return adapter;
  }

  getAll(): IProtocolAdapter[] {
    return Array.from(this.adapters.values());
  }

  // Fetch live APYs from all protocols — used by strategy engine to inject real rates
  async fetchLiveApys(): Promise<{
    aave: { usdc: number; weth: number; cbEth: number };
    morpho: { steakhouseUsdc: number };
  }> {
    const aaveAdapter = this.get("aave-v3") as AaveV3Adapter;
    const morphoAdapter = this.get("morpho-blue") as MorphoBlueAdapter;

    const [aaveUsdc, aaveWeth, aaveCbEth, morphoData] =
      await Promise.allSettled([
        aaveAdapter.getMarket("USDC"),
        aaveAdapter.getMarket("WETH"),
        aaveAdapter.getMarket("cbETH"),
        morphoAdapter.getMarkets().then(m => {
          const usdc = m.find(x => x.asset === "USDC");
          if (!usdc) throw new Error("Morpho Steakhouse USDC market unavailable");
          return { apyBps: usdc.supplyApyBps };
        }),
      ]);

    if (aaveUsdc.status !== "fulfilled" || !aaveUsdc.value) throw new Error("Aave USDC APY unavailable");
    if (aaveWeth.status !== "fulfilled" || !aaveWeth.value) throw new Error("Aave WETH APY unavailable");
    if (aaveCbEth.status !== "fulfilled" || !aaveCbEth.value) throw new Error("Aave cbETH APY unavailable");
    if (morphoData.status !== "fulfilled") throw new Error("Morpho Steakhouse APY unavailable");

    return {
      aave: {
        usdc: aaveUsdc.value.supplyApyBps,
        weth: aaveWeth.value.supplyApyBps,
        cbEth: aaveCbEth.value.supplyApyBps,
      },
      morpho: {
        steakhouseUsdc: morphoData.value.apyBps,
      },
    };
  }

  // Build a rich context string for LLM injection
  buildLLMContext(): string {
    const sections = this.getAll().map((adapter) => {
      const caps = adapter.getCapabilities();
      return `
=== ${adapter.metadata.displayName} (${adapter.protocol}) ===
Chain: Base (chainId 8453)
TVL: $${(adapter.metadata.tvlUsd / 1e6).toFixed(0)}M
Audited: ${adapter.metadata.audited} (${adapter.metadata.auditCount} audits)
Live for: ${adapter.metadata.deployedMonths} months

${caps.semanticDescription}
      `.trim();
    });

    return sections.join("\n\n");
  }
}

// Singleton for use across the app
export const protocolRegistry = new ProtocolRegistry();
