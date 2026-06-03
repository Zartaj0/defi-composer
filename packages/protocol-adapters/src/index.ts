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

  // Fetch live APYs from all protocols — used by strategy engine to inject real rates.
  // Returns partial data with null for any protocol that fails; never throws.
  async fetchLiveApys(): Promise<{
    aave: { usdc: number | null; weth: number | null; cbEth: number | null };
    morpho: { steakhouseUsdc: number | null };
  }> {
    const aaveAdapter = this.get("aave-v3") as AaveV3Adapter;
    const morphoAdapter = this.get("morpho-blue") as MorphoBlueAdapter;

    // 10-second timeout per call so a hung RPC doesn't stall the endpoint
    function withTimeout<T>(p: Promise<T>, ms = 10_000): Promise<T | null> {
      return Promise.race([
        p.then(v => v).catch(() => null),
        new Promise<null>(resolve => setTimeout(() => resolve(null), ms)),
      ]);
    }

    const [aaveUsdc, aaveWeth, aaveCbEth, morphoData] = await Promise.all([
      withTimeout(aaveAdapter.getMarket("USDC")),
      withTimeout(aaveAdapter.getMarket("WETH")),
      withTimeout(aaveAdapter.getMarket("cbETH")),
      withTimeout(
        morphoAdapter.getMarkets().then(m => {
          const usdc = m.find(x => x.asset === "USDC");
          return usdc ? { apyBps: usdc.supplyApyBps } : null;
        })
      ),
    ]);

    return {
      aave: {
        usdc: aaveUsdc?.supplyApyBps ?? null,
        weth: aaveWeth?.supplyApyBps ?? null,
        cbEth: aaveCbEth?.supplyApyBps ?? null,
      },
      morpho: {
        steakhouseUsdc: morphoData?.apyBps ?? null,
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
