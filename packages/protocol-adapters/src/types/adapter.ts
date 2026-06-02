import type {
  AssetSymbol,
  ChainId,
  ProtocolMetadata,
  ProtocolName,
} from "@defi-composer/shared";

// ─── Market Data ─────────────────────────────────────────────
export interface ProtocolMarket {
  asset: AssetSymbol;
  supplyApyBps: number;      // basis points
  borrowApyBps: number;
  utilizationPct: number;    // 0-100
  liquidityUsd: number;      // available liquidity
  tvlUsd: number;
  ltv?: number;              // loan-to-value ratio (for lending)
  liquidationThreshold?: number;
  rewardApyBps?: number;     // additional token rewards
  totalSupplyUsd: number;
  totalBorrowUsd: number;
}

// ─── Pool Data (for DEX / LP protocols) ──────────────────────
export interface ProtocolPool {
  id: string;
  token0: AssetSymbol;
  token1: AssetSymbol;
  feeApyBps: number;
  rewardApyBps: number;
  totalApyBps: number;
  tvlUsd: number;
  volume24hUsd: number;
  stable: boolean;
  gauge?: `0x${string}`;   // reward gauge address
}

// ─── Protocol Adapter Interface ──────────────────────────────
export interface IProtocolAdapter {
  protocol: ProtocolName;
  chainId: ChainId;
  metadata: ProtocolMetadata;

  // Fetch live market data
  getMarkets(): Promise<ProtocolMarket[]>;

  // Fetch pool data (DEX protocols)
  getPools?(): Promise<ProtocolPool[]>;

  // Get market for specific asset
  getMarket(asset: AssetSymbol): Promise<ProtocolMarket | null>;

  // Build action calldata (deterministic, no AI)
  buildSupplyCalldata?(
    asset: AssetSymbol,
    amount: bigint,
    onBehalfOf: `0x${string}`
  ): Promise<EncodedAction>;

  buildBorrowCalldata?(
    asset: AssetSymbol,
    amount: bigint,
    onBehalfOf: `0x${string}`
  ): Promise<EncodedAction>;

  buildWithdrawCalldata?(
    asset: AssetSymbol,
    amount: bigint,
    receiver: `0x${string}`
  ): Promise<EncodedAction>;

  buildAddLiquidityCalldata?(
    token0: AssetSymbol,
    token1: AssetSymbol,
    amount0: bigint,
    amount1: bigint,
    stable: boolean,
    receiver: `0x${string}`
  ): Promise<EncodedAction>;

  // Health factor for borrow positions
  getHealthFactor?(
    account: `0x${string}`
  ): Promise<number | null>;

  // Get semantic capabilities for strategy planning
  getCapabilities(): ProtocolCapabilities;
}

// ─── Encoded Action (for execution engine) ───────────────────
export interface EncodedAction {
  protocol: ProtocolName;
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  gasEstimate: bigint;
  description: string;
}

// ─── Protocol Capabilities ───────────────────────────────────
// Used by the Strategy Planner to reason about what each protocol can do
export interface ProtocolCapabilities {
  canSupply: boolean;
  canBorrow: boolean;
  canProvideLiquidity: boolean;
  canStake: boolean;
  supportsLeverage: boolean;
  hasLiquidationRisk: boolean;
  hasImpermanentLoss: boolean;
  hasLockup: boolean;
  lockupDays?: number;
  supportedAssets: AssetSymbol[];
  supportedPairs?: [AssetSymbol, AssetSymbol][];
  semanticDescription: string; // for LLM context injection
}
