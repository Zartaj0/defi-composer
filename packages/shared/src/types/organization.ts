// ============================================================
// Organization Model
// Multi-wallet, treasury-first entities: DAOs, companies, funds
// ============================================================

import type { ChainId, AssetSymbol, Position, CandidateStrategy } from "./index.js";

// ─── Organization ─────────────────────────────────────────────
export type OrgType = "dao" | "startup" | "fund" | "individual";

export interface Organization {
  id: string;
  name: string;
  type: OrgType;
  logoUrl?: string;

  // Treasury config
  treasuryWallets: TreasuryWallet[];
  managedBySmartAccount?: `0x${string}`; // the Safe/ERC4337 account we operate through

  // Risk parameters — governance-approved limits
  riskParams: OrgRiskParams;

  // Subscription / fee model
  feeConfig: FeeConfig;

  // Integrations
  safeAddress?: `0x${string}`;
  notificationChannels: NotificationChannel[];

  // Metadata
  createdAt: Date;
  onboardedAt?: Date;
  website?: string;
  governanceUrl?: string; // e.g. snapshot.org link
}

export interface TreasuryWallet {
  address: `0x${string}`;
  chainId: ChainId;
  label: string; // e.g. "Main Treasury", "Grants Multisig"
  isManaged: boolean; // whether DeFi Composer manages this wallet
}

// ─── Org Risk Parameters ─────────────────────────────────────
// These are governance-approved limits. The system NEVER exceeds them.
// Changing them requires a governance proposal (for DAOs) or admin action (for companies).
export interface OrgRiskParams {
  maxAllocationPerProtocolPct: number; // e.g. 40 = max 40% in any single protocol
  maxDrawdownPct: number;              // e.g. 10 = halt if portfolio drops 10%
  allowLeverage: boolean;
  allowLiquidationRisk: boolean;
  allowGovernanceTokenRewards: boolean;
  minLiquidityReservePct: number;      // e.g. 20 = keep 20% instantly withdrawable
  approvedProtocols: string[];         // only deploy to these protocols
  approvedChains: ChainId[];
  maxSinglePositionPct: number;        // e.g. 30 = no single position > 30% of portfolio
  requireMultisigForNewStrategy: boolean; // DAO mode: new strategies need Safe approval
}

// ─── Fee Configuration ────────────────────────────────────────
export interface FeeConfig {
  managementFeeBps: number;    // e.g. 10 = 0.10% annually
  performanceFeePct: number;   // e.g. 10 = 10% of yield above benchmark
  benchmarkRateBps: number;    // e.g. 450 = 4.5% (risk-free rate)
  feeRecipient: `0x${string}`; // where fees are sent
  billingCycle: "monthly" | "quarterly" | "annual";
}

// ─── Notification Channels ────────────────────────────────────
export type NotificationChannelType = "email" | "telegram" | "discord" | "slack" | "webhook";

export interface NotificationChannel {
  type: NotificationChannelType;
  destination: string;
  enabledAlerts: AlertType[];
}

// ─── Treasury Snapshot ───────────────────────────────────────
// Point-in-time view of the entire treasury
export interface TreasurySnapshot {
  orgId: string;
  timestamp: Date;

  // Aggregate values
  totalAumUsd: number;
  managedAumUsd: number;      // amount actively deployed by Composer
  idleAumUsd: number;         // not yet deployed
  totalYieldEarned24hUsd: number;
  totalYieldEarnedAllTimeUsd: number;
  projectedAnnualYieldUsd: number;
  weightedAvgApyBps: number;

  // Breakdown by protocol
  protocolAllocations: ProtocolAllocation[];

  // Breakdown by asset
  assetAllocations: AssetAllocation[];

  // Active positions
  activePositions: Position[];

  // Risk summary
  portfolioHealthScore: number;     // 0-100, 100 = perfect health
  lowestHealthFactor?: number;      // minimum across all leveraged positions
  nearLiquidationPositions: string[]; // position IDs with HF < 1.3
}

export interface ProtocolAllocation {
  protocol: string;
  allocationUsd: number;
  allocationPct: number;
  apyBps: number;
  yieldEarned24hUsd: number;
}

export interface AssetAllocation {
  asset: AssetSymbol;
  balanceNative: string;  // in token units
  balanceUsd: number;
  allocationPct: number;
  isYielding: boolean;
}

// ─── Performance Tracking ────────────────────────────────────
export interface PortfolioPerformance {
  orgId: string;
  period: "24h" | "7d" | "30d" | "90d" | "1y" | "all";
  startDate: Date;
  endDate: Date;

  // Returns
  absoluteReturnUsd: number;
  absoluteReturnPct: number;
  benchmarkReturnPct: number;    // risk-free rate over the period
  alphaVsBenchmarkPct: number;   // how much we beat benchmark

  // Per-strategy breakdown
  strategyAttribution: StrategyAttribution[];

  // Fees paid
  managementFeePaidUsd: number;
  performanceFeePaidUsd: number;
  gasFeesPaidUsd: number;
  netReturnAfterFeesUsd: number;

  // Risk metrics over period
  maxDrawdownPct: number;
  sharpeRatio?: number;
  volatilityPct?: number;

  // Events
  rebalanceCount: number;
  harvestCount: number;
  liquidationEvents: number; // should always be 0
}

export interface StrategyAttribution {
  strategyId: string;
  strategyName: string;
  protocol: string;
  capitalDeployedUsd: number;
  yieldEarnedUsd: number;
  returnPct: number;
  contributionToBenchmarkPct: number; // weighted contribution to portfolio alpha
  gasCostUsd: number;
  netReturnUsd: number;
}

// ─── Alerts ──────────────────────────────────────────────────
export type AlertType =
  | "health_factor_warning"   // HF drops below 1.5
  | "health_factor_critical"  // HF drops below 1.2
  | "apy_collapse"            // APY drops > 50% from when deployed
  | "protocol_incident"       // Aave/Morpho/etc reports a security event
  | "rebalance_triggered"     // system auto-rebalanced
  | "strategy_degraded"       // strategy performance below benchmark for 7+ days
  | "new_opportunity"         // significantly better APY available
  | "drawdown_limit_breach"   // portfolio drawdown exceeds org limit
  | "idle_capital_detected";  // capital sitting uninvested

export type AlertSeverity = "info" | "warning" | "critical";

export interface Alert {
  id: string;
  orgId: string;
  positionId?: string;
  strategyId?: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  actionRequired: boolean;
  actionUrl?: string;
  resolvedAt?: Date;
  createdAt: Date;

  // Structured data for the alert
  data: Record<string, unknown>;
}

// ─── Strategy Marketplace ────────────────────────────────────
export interface MarketplaceListing {
  id: string;
  strategyId: string;
  strategyName: string;
  tagline: string;
  description: string;

  // Curator
  curatorAddress: `0x${string}`;
  curatorName: string;
  curatorReputation: number; // 0-100, based on track record

  // Strategy config
  primaryProtocols: string[];
  primaryAssets: AssetSymbol[];
  riskLevel: "very_low" | "low" | "medium" | "high";
  requiresLeverage: boolean;

  // Live metrics
  tvlManagedUsd: number;
  organizationsUsing: number;
  deployedAt: Date;

  // Track record
  trackRecord: StrategyTrackRecord;

  // Economics
  curatorPerformanceFeePct: number; // cut of performance fee that goes to curator
}

export interface StrategyTrackRecord {
  // Historical APY
  apy7dBps: number;
  apy30dBps: number;
  apy90dBps: number;
  apyAllTimeBps: number;

  // Risk history
  maxDrawdownPct: number;
  liquidationEvents: number; // should be 0
  worstMonthReturnPct: number;

  // Reliability
  uptimePct: number;    // % of time strategy was active (not paused)
  rebalanceFrequency: number; // avg per month

  // Verification
  onChainHistoryUrl: string; // link to on-chain evidence
  lastVerifiedAt: Date;
}

// ─── Governance ──────────────────────────────────────────────
export interface GovernanceProposal {
  id: string;
  orgId: string;
  title: string;
  description: string;
  type: "deploy_strategy" | "change_risk_params" | "withdraw_funds" | "pause_all";

  // What's being proposed
  proposedChange: Record<string, unknown>;

  // Safe transaction data (pre-built, ready to sign)
  safeTxData?: {
    to: `0x${string}`;
    data: `0x${string}`;
    value: string;
    nonce: number;
  };

  // Snapshot/on-chain vote integration
  snapshotProposalUrl?: string;
  onChainProposalId?: string;

  status: "draft" | "voting" | "approved" | "rejected" | "executed";
  approvals: `0x${string}`[];
  rejections: `0x${string}`[];
  threshold: number; // signers needed

  createdAt: Date;
  votingEndsAt?: Date;
  executedAt?: Date;
}
