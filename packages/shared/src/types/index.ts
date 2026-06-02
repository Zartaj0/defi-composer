// ============================================================
// DeFi Composer — Shared Types
// Central type definitions used across all packages
// ============================================================

// ─── Chain ───────────────────────────────────────────────────
export type ChainId = 8453 | 1 | 42161; // Base | Ethereum | Arbitrum

export const CHAINS: Record<ChainId, string> = {
  8453: "base",
  1: "ethereum",
  42161: "arbitrum",
};

// ─── Assets ──────────────────────────────────────────────────
export type AssetSymbol =
  | "ETH"
  | "WETH"
  | "USDC"
  | "USDT"
  | "DAI"
  | "cbETH"
  | "wstETH"
  | "rETH"
  | "AERO";

export interface Asset {
  symbol: AssetSymbol;
  address: `0x${string}`;
  decimals: number;
  chainId: ChainId;
  isStable: boolean;
  isLST: boolean; // Liquid Staking Token
}

// ─── Protocol ────────────────────────────────────────────────
export type ProtocolName = "aave-v3" | "morpho-blue" | "uniswap-v3";

export type ProtocolCategory =
  | "lending"
  | "dex"
  | "yield"
  | "derivatives"
  | "staking";

export interface ProtocolMetadata {
  name: ProtocolName;
  displayName: string;
  category: ProtocolCategory;
  chainId: ChainId;
  tvlUsd: number;
  audited: boolean;
  auditCount: number;
  deployedMonths: number; // months live — proxy for maturity
  hasLiquidationRisk: boolean;
  hasLockup: boolean;
  lockupDays?: number;
  supportsLeverage: boolean;
  governanceTokenRisk: "none" | "low" | "medium" | "high";
  contractAddresses: Record<string, `0x${string}`>;
}

// ─── User Intent ─────────────────────────────────────────────
export type GoalType =
  | "yield_generation"
  | "capital_preservation"
  | "leveraged_yield"
  | "delta_neutral"
  | "lp_farming";

export type RiskTolerance = "conservative" | "moderate" | "aggressive";

export type LiquidityPreference = "instant" | "daily" | "weekly" | "locked";

export interface UserIntent {
  id: string;
  rawInput: string; // original natural language
  goal: GoalType;
  primaryAsset: AssetSymbol;
  capitalUsd: number;
  riskTolerance: RiskTolerance;
  liquidityPreference: LiquidityPreference;
  maxDrawdownPct: number; // e.g. 10 = max 10% drawdown
  allowLeverage: boolean;
  allowLiquidationRisk: boolean;
  allowGovernanceTokens: boolean;
  preferredChain: ChainId;
  constraints: string[]; // additional freeform constraints
  createdAt: Date;
}

// ─── Strategy Graph ──────────────────────────────────────────
export type ActionType =
  | "deposit"
  | "withdraw"
  | "supply"
  | "borrow"
  | "repay"
  | "swap"
  | "add_liquidity"
  | "remove_liquidity"
  | "stake"
  | "unstake"
  | "claim_rewards"
  | "compound";

export interface StrategyNode {
  id: string;
  protocol: ProtocolName;
  action: ActionType;
  inputAsset: AssetSymbol;
  outputAsset: AssetSymbol;
  inputAmount?: bigint; // set at execution time
  expectedOutputAmount?: bigint;
  expectedApyBps: number; // basis points, e.g. 500 = 5%
  gasCostUsd: number;
  risks: NodeRisk[];
  metadata: Record<string, unknown>;
}

export interface NodeRisk {
  type: "liquidation" | "impermanent_loss" | "smart_contract" | "oracle" | "liquidity";
  severity: "low" | "medium" | "high";
  description: string;
}

export interface StrategyEdge {
  from: string; // node id
  to: string; // node id
  assetFlow: AssetSymbol;
  description: string;
}

export interface StrategyGraph {
  id: string;
  name: string;
  description: string;
  nodes: StrategyNode[];
  edges: StrategyEdge[];
  entryAsset: AssetSymbol;
  exitAsset: AssetSymbol;
  estimatedApyBps: number;
  estimatedDailyYieldUsd?: number;
  totalGasCostUsd: number;
  createdAt: Date;
}

// ─── Risk Score ───────────────────────────────────────────────
export type RiskLevel = "very_low" | "low" | "medium" | "high" | "very_high";

export interface RiskScore {
  overall: number; // 0–10
  overallLevel: RiskLevel;
  marketRisk: number;
  liquidationRisk: number;
  protocolRisk: number;
  liquidityRisk: number;
  oracleRisk: number;
  breakdown: RiskBreakdownItem[];
  warnings: string[];
  blockers: string[]; // hard blockers that prevent deployment
}

export interface RiskBreakdownItem {
  factor: string;
  score: number;
  weight: number;
  contribution: number;
  description: string;
}

// ─── Simulation Result ───────────────────────────────────────
export interface SimulationResult {
  strategyId: string;
  success: boolean;
  error?: string;
  capitalFlow: CapitalFlowStep[];
  projectedApyBps: number;
  projectedDailyYieldUsd: number;
  totalGasCostUsd: number;
  slippagePct: number;
  liquidationBuffer?: number; // health factor after entry
  stressTest: StressTestResult;
  simulatedAt: Date;
}

export interface CapitalFlowStep {
  nodeId: string;
  protocol: ProtocolName;
  action: ActionType;
  inputAmount: string; // human readable
  outputAmount: string;
  gasCostUsd: number;
}

export interface StressTestResult {
  minDrawdownScenario: string;
  maxDrawdownPct: number;
  liquidationScenario?: string;
  survives30PctDrop: boolean;
  survives50PctDrop: boolean;
}

// ─── Candidate Strategy ──────────────────────────────────────
export interface CandidateStrategy {
  id: string;
  intentId: string;
  name: string;
  tagline: string; // e.g. "Safe stablecoin lending"
  graph: StrategyGraph;
  riskScore: RiskScore;
  simulation?: SimulationResult;
  aiRationale: string; // LLM explanation
  rank: number; // 1 = best
  recommended: boolean;
}

// ─── Position ────────────────────────────────────────────────
export type PositionStatus =
  | "pending"
  | "deploying"
  | "active"
  | "rebalancing"
  | "withdrawing"
  | "closed"
  | "failed";

export interface Position {
  id: string;
  userId: string;
  strategyId: string;
  graph: StrategyGraph;
  status: PositionStatus;
  capitalUsd: number;
  currentValueUsd: number;
  realizedYieldUsd: number;
  unrealizedYieldUsd: number;
  smartAccountAddress: `0x${string}`;
  chainId: ChainId;
  deployedAt: Date;
  lastRebalancedAt?: Date;
  healthFactor?: number;
  transactions: PositionTransaction[];
}

export interface PositionTransaction {
  hash: `0x${string}`;
  type: "deploy" | "rebalance" | "harvest" | "exit";
  timestamp: Date;
  gasCostUsd: number;
  description: string;
}

// ─── API Response ────────────────────────────────────────────
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  requestId: string;
  timestamp: Date;
}
