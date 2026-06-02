// ============================================================
// Treasury Routes
// Aggregate portfolio view for the dashboard.
// Feeds TreasuryDashboard.tsx via useTreasury.ts hooks.
// ============================================================

import type { FastifyPluginAsync } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { createPublicClient, http, type Address } from "viem";
import { base } from "viem/chains";
import { protocolRegistry } from "@defi-composer/protocol-adapters";
import {
  getOrg,
  listOrgs,
  listActivePositions,
  listOrgAlerts,
  countUnresolvedCritical,
  createOrg,
  addTreasuryWallet,
  updateOrgRiskParams,
} from "@defi-composer/db";
import type {
  TreasurySnapshot,
  ProtocolAllocation,
  AssetAllocation,
  Position as SharedPosition,
} from "@defi-composer/shared";

// ─── On-chain readers ─────────────────────────────────────────────────────────
const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env["BASE_RPC_URL"] ?? "https://mainnet.base.org"),
});

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function" as const,
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view" as const,
  },
] as const;

const TOKEN_ADDRESSES: Record<string, { address: Address; decimals: number }> = {
  USDC:   { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  WETH:   { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
  cbETH:  { address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18 },
  wstETH: { address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", decimals: 18 },
};

// Rough USD prices — in production these come from Chainlink on-chain
const ASSET_PRICES_USD: Record<string, number> = {
  USDC: 1.0,
  WETH: 3_000,
  cbETH: 3_150,
  wstETH: 3_500,
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const DEFAULT_FEE_RECIPIENT = "0x1111111111111111111111111111111111111111" as const;

type TreasuryOrgType = "dao" | "startup" | "fund" | "individual";
type RiskProfile = "conservative" | "moderate" | "aggressive";

function slugifyOrgId(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `org_${slug || uuidv4().slice(0, 8)}`;
}

function buildRiskParams(
  profile: RiskProfile,
  type: TreasuryOrgType,
  overrides: Partial<{
    maxAllocationPerProtocolPct: number;
    maxDrawdownPct: number;
    allowLeverage: boolean;
    allowLiquidationRisk: boolean;
    allowGovernanceTokenRewards: boolean;
    minLiquidityReservePct: number;
    approvedProtocols: string[];
    approvedChains: number[];
    maxSinglePositionPct: number;
    requireMultisigForNewStrategy: boolean;
  }> = {}
) {
  const defaultsByProfile = {
    conservative: {
      maxAllocationPerProtocolPct: 35,
      maxDrawdownPct: 5,
      allowLeverage: false,
      allowLiquidationRisk: false,
      allowGovernanceTokenRewards: false,
      minLiquidityReservePct: 30,
      maxSinglePositionPct: 25,
    },
    moderate: {
      maxAllocationPerProtocolPct: 45,
      maxDrawdownPct: 12,
      allowLeverage: false,
      allowLiquidationRisk: false,
      allowGovernanceTokenRewards: false,
      minLiquidityReservePct: 20,
      maxSinglePositionPct: 35,
    },
    aggressive: {
      maxAllocationPerProtocolPct: 60,
      maxDrawdownPct: 25,
      allowLeverage: false,
      allowLiquidationRisk: false,
      allowGovernanceTokenRewards: false,
      minLiquidityReservePct: 10,
      maxSinglePositionPct: 45,
    },
  } as const;

  const base = defaultsByProfile[profile];
  return {
    ...base,
    approvedProtocols: ["aave-v3", "morpho-blue", "uniswap-v3"],
    approvedChains: [8453],
    requireMultisigForNewStrategy: type !== "individual",
    ...overrides,
  };
}

function buildFeeConfig(
  feeConfig?: Partial<{
    managementFeeBps: number;
    performanceFeePct: number;
    benchmarkRateBps: number;
    curatorFeePct: number;
    feeRecipient: `0x${string}`;
    billingCycle: "monthly" | "quarterly" | "annual";
  }>
) {
  return {
    managementFeeBps: 10,
    performanceFeePct: 10,
    benchmarkRateBps: 530,
    curatorFeePct: 0,
    feeRecipient: DEFAULT_FEE_RECIPIENT,
    billingCycle: "monthly" as const,
    ...feeConfig,
  };
}

async function readWalletBalances(
  walletAddress: Address
): Promise<AssetAllocation[]> {
  const results = await Promise.allSettled(
    Object.entries(TOKEN_ADDRESSES).map(async ([symbol, { address, decimals }]) => {
      const raw = await publicClient.readContract({
        address,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [walletAddress],
      });
      const native = Number(raw) / 10 ** decimals;
      const usd = native * (ASSET_PRICES_USD[symbol] ?? 0);
      return { symbol, native, usd };
    })
  );

  const allocations: AssetAllocation[] = [];
  let totalUsd = 0;

  for (const r of results) {
    if (r.status === "fulfilled" && r.value.usd > 0.01) {
      totalUsd += r.value.usd;
    }
  }

  for (const r of results) {
    if (r.status === "fulfilled" && r.value.usd > 0.01) {
      allocations.push({
        asset: r.value.symbol as any,
        balanceNative: r.value.native.toFixed(6),
        balanceUsd: r.value.usd,
        allocationPct: totalUsd > 0 ? (r.value.usd / totalUsd) * 100 : 0,
        isYielding: false, // wallet holdings are idle (not in a yield position)
      });
    }
  }

  return allocations;
}

// ─── Routes ───────────────────────────────────────────────────────────────────
export const treasuryRoutes: FastifyPluginAsync = async (app) => {
  // ── GET /orgs — list organizations ─────────────────────────────────────────
  app.get("/orgs", async (_request, reply) => {
    try {
      const orgs = await listOrgs();
      return reply.send({
        success: true,
        data: orgs,
        requestId: uuidv4(),
        timestamp: new Date(),
      });
    } catch (err) {
      app.log.error(err);
      return reply.status(500).send({
        success: false,
        error: "Failed to list organizations",
        requestId: uuidv4(),
        timestamp: new Date(),
      });
    }
  });

  // ── GET /:orgId/snapshot — full treasury state ──────────────────────────────
  app.get<{ Params: { orgId: string } }>(
    "/:orgId/snapshot",
    async (request, reply) => {
      try {
        const org = await getOrg(request.params.orgId);
        if (!org) {
          return reply.status(404).send({
            success: false,
            error: "Organization not found",
            requestId: uuidv4(),
            timestamp: new Date(),
          });
        }

        const positions = await listActivePositions(request.params.orgId);

        // ── Managed AUM (from deployed positions) ─────────────────────────────
        const managedAumUsd = positions.reduce(
          (sum, p) => sum + (p.currentValueUsd ?? p.entryValueUsd ?? 0),
          0
        );

        // ── Yield earned in last 24h ───────────────────────────────────────────
        // Approximated: cumulative yield / days since deployment / 30
        const totalYieldEarned24hUsd = positions.reduce((sum, p) => {
          const deployedDays = Math.max(
            1,
            (Date.now() - p.createdAt.getTime()) / 86_400_000
          );
          return sum + (p.yieldEarnedUsd ?? 0) / deployedDays;
        }, 0);

        // ── Protocol allocation breakdown with live APY ────────────────────────
        // Fetch live APY for each unique protocol in use
        const protocolMap = new Map<string, { allocationUsd: number; apyBps: number }>();
        for (const pos of positions) {
          const proto = pos.graph.nodes[0]?.protocol ?? "unknown";
          const existing = protocolMap.get(proto) ?? { allocationUsd: 0, apyBps: 0 };
          existing.allocationUsd += pos.currentValueUsd ?? pos.entryValueUsd ?? 0;
          protocolMap.set(proto, existing);
        }

        // Enrich with live APYs from protocol adapters (Morpho GraphQL etc.)
        await Promise.allSettled(
          Array.from(protocolMap.entries()).map(async ([proto, entry]) => {
            try {
              const adapter = protocolRegistry.get(proto as any);
              const markets = await adapter.getMarkets();
              // Weight APY by USDC market (most common)
              const primary = markets.find((m) => m.asset === "USDC") ?? markets[0];
              if (primary) entry.apyBps = primary.supplyApyBps;
            } catch {
              // Use position's estimated APY as fallback
              const pos = positions.find(
                (p) => (p.graph.nodes[0]?.protocol ?? "unknown") === proto
              );
              entry.apyBps = pos?.graph.estimatedApyBps ?? 0;
            }
          })
        );

        const protocolAllocations: ProtocolAllocation[] = Array.from(
          protocolMap.entries()
        ).map(([protocol, { allocationUsd, apyBps }]) => ({
          protocol,
          allocationUsd,
          allocationPct:
            managedAumUsd > 0 ? (allocationUsd / managedAumUsd) * 100 : 0,
          apyBps,
          // Daily yield from this protocol: allocationUsd * (apyBps/10000) / 365
          yieldEarned24hUsd: allocationUsd * (apyBps / 10_000) / 365,
        }));

        // ── Weighted average APY ───────────────────────────────────────────────
        const weightedApyBps =
          managedAumUsd > 0
            ? protocolAllocations.reduce((sum, pa) => {
                const weight = pa.allocationUsd / managedAumUsd;
                return sum + pa.apyBps * weight;
              }, 0)
            : 0;

        // ── Idle capital: read on-chain wallet balances ────────────────────────
        let idleAumUsd = 0;
        let walletAssetAllocations: AssetAllocation[] = [];

        const managedWallets = org.wallets.filter(
          (w) => w.chainId === 8453
        );

        if (managedWallets.length > 0) {
          const walletBalancesResults = await Promise.allSettled(
            managedWallets.map((w) =>
              readWalletBalances(w.address as Address)
            )
          );

          for (const result of walletBalancesResults) {
            if (result.status === "fulfilled") {
              for (const alloc of result.value) {
                idleAumUsd += alloc.balanceUsd;
                walletAssetAllocations.push(alloc);
              }
            }
          }
        }

        // ── Health score ───────────────────────────────────────────────────────
        const leveragedPositions = positions.filter((p) => p.healthFactor !== null);
        const lowestHealthFactor =
          leveragedPositions.length > 0
            ? Math.min(...leveragedPositions.map((p) => p.healthFactor!))
            : undefined;

        const criticalAlerts = await countUnresolvedCritical(
          request.params.orgId
        );
        let healthScore = 100;
        if (lowestHealthFactor !== undefined && lowestHealthFactor < 1.5) {
          healthScore -= Math.min(40, (1.5 - lowestHealthFactor) * 100);
        }
        if (criticalAlerts > 0) healthScore -= criticalAlerts * 10;
        healthScore = Math.max(0, Math.round(healthScore));

        // ── Active positions — map DB type to dashboard-compatible summary ─────
        const activePositions = positions.map((p) => ({
          id: p.id,
          userId: p.orgId,
          strategyId: p.intentId ?? p.id,
          graph: p.graph,
          status: p.status as SharedPosition["status"],
          capitalUsd: p.entryValueUsd ?? 0,
          currentValueUsd: p.currentValueUsd ?? p.entryValueUsd ?? 0,
          realizedYieldUsd: p.yieldEarnedUsd ?? 0,
          unrealizedYieldUsd: 0,
          smartAccountAddress: (p.safeAddress ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
          chainId: p.chainId as 8453,
          deployedAt: p.createdAt,
          ...(p.healthFactor !== null && p.healthFactor !== undefined ? { healthFactor: p.healthFactor } : {}),
          transactions: [],
        })) satisfies SharedPosition[];

        // ── Final snapshot ─────────────────────────────────────────────────────
        const snapshot: TreasurySnapshot = {
          orgId: request.params.orgId,
          timestamp: new Date(),
          totalAumUsd: managedAumUsd + idleAumUsd,
          managedAumUsd,
          idleAumUsd,
          totalYieldEarned24hUsd,
          totalYieldEarnedAllTimeUsd: positions.reduce(
            (sum, p) => sum + (p.yieldEarnedUsd ?? 0),
            0
          ),
          projectedAnnualYieldUsd: managedAumUsd * (weightedApyBps / 10_000),
          weightedAvgApyBps: Math.round(weightedApyBps),
          protocolAllocations,
          assetAllocations: walletAssetAllocations,
          activePositions,
          portfolioHealthScore: healthScore,
          ...(lowestHealthFactor !== undefined ? { lowestHealthFactor } : {}),
          nearLiquidationPositions: positions
            .filter((p) => p.healthFactor !== null && p.healthFactor! < 1.3)
            .map((p) => p.id),
        };

        return reply.send({
          success: true,
          data: snapshot,
          requestId: uuidv4(),
          timestamp: new Date(),
        });
      } catch (err) {
        app.log.error(err);
        return reply.status(500).send({
          success: false,
          error: "Failed to build treasury snapshot",
          requestId: uuidv4(),
          timestamp: new Date(),
        });
      }
    }
  );

  // ── GET /:orgId/alerts ───────────────────────────────────────────────────────
  app.get<{
    Params: { orgId: string };
    Querystring: { unacknowledgedOnly?: string; limit?: string };
  }>("/:orgId/alerts", async (request, reply) => {
    try {
      const alerts = await listOrgAlerts(request.params.orgId, {
        limit: request.query.limit ? parseInt(request.query.limit) : 50,
        unacknowledgedOnly: request.query.unacknowledgedOnly === "true",
      });
      return reply.send({
        success: true,
        data: alerts,
        requestId: uuidv4(),
        timestamp: new Date(),
      });
    } catch (err) {
      app.log.error(err);
      return reply.status(500).send({
        success: false,
        error: "Failed to fetch alerts",
        requestId: uuidv4(),
        timestamp: new Date(),
      });
    }
  });

  // ── POST /orgs — create organization ─────────────────────────────────────────
  app.post<{
    Body: {
      id?: string;
      name: string;
      type: TreasuryOrgType;
      safeAddress?: string;
      walletAddress?: string;
      riskProfile?: RiskProfile;
      riskParams?: Partial<{
        maxAllocationPerProtocolPct: number;
        maxDrawdownPct: number;
        allowLeverage: boolean;
        allowLiquidationRisk: boolean;
        allowGovernanceTokenRewards: boolean;
        minLiquidityReservePct: number;
        approvedProtocols: string[];
        approvedChains: number[];
        maxSinglePositionPct: number;
        requireMultisigForNewStrategy: boolean;
      }>;
      feeConfig?: Partial<{
        managementFeeBps: number;
        performanceFeePct: number;
        benchmarkRateBps: number;
        curatorFeePct: number;
        feeRecipient: `0x${string}`;
        billingCycle: "monthly" | "quarterly" | "annual";
      }>;
    };
  }>("/orgs", async (request, reply) => {
    try {
      const {
        id,
        name,
        type,
        safeAddress,
        walletAddress,
        riskProfile = "conservative",
        riskParams,
        feeConfig,
      } = request.body;
      const orgId = id ?? slugifyOrgId(name);
      const resolvedSafe = safeAddress && safeAddress !== ZERO_ADDRESS ? safeAddress : null;
      const resolvedWallet =
        walletAddress && walletAddress !== ZERO_ADDRESS
          ? walletAddress
          : resolvedSafe;

      const org = await createOrg({
        id: orgId,
        name,
        type,
        safeAddress: resolvedSafe,
        riskParams: buildRiskParams(riskProfile, type, riskParams),
        feeConfig: buildFeeConfig(feeConfig),
        notificationChannels: [],
      });

      if (resolvedWallet) {
        await addTreasuryWallet({
          id: `wallet_${uuidv4().slice(0, 8)}`,
          orgId,
          address: resolvedWallet,
          chainId: 8453,
          role: "treasury",
          label: resolvedSafe ? "Primary Safe Treasury" : "Primary Treasury",
          isManaged: Boolean(resolvedSafe),
        });
      }

      return reply.status(201).send({
        success: true,
        data: {
          ...org,
          walletAddress: resolvedWallet,
        },
        requestId: uuidv4(),
        timestamp: new Date(),
      });
    } catch (err) {
      app.log.error(err);
      return reply.status(500).send({
        success: false,
        error: "Failed to create organization",
        requestId: uuidv4(),
        timestamp: new Date(),
      });
    }
  });

  // ── PUT /orgs/:orgId/risk-params — update treasury policy ─────────────────
  app.put<{
    Params: { orgId: string };
    Body: Partial<{
      maxAllocationPerProtocolPct: number;
      maxDrawdownPct: number;
      allowLeverage: boolean;
      allowLiquidationRisk: boolean;
      allowGovernanceTokenRewards: boolean;
      minLiquidityReservePct: number;
      approvedProtocols: string[];
      approvedChains: number[];
      maxSinglePositionPct: number;
      requireMultisigForNewStrategy: boolean;
    }>;
  }>("/orgs/:orgId/risk-params", async (request, reply) => {
    try {
      const org = await getOrg(request.params.orgId);
      if (!org) {
        return reply.status(404).send({
          success: false,
          error: "Organization not found",
          requestId: uuidv4(),
          timestamp: new Date(),
        });
      }

      const [updated] = await updateOrgRiskParams(request.params.orgId, {
        ...org.riskParams,
        ...request.body,
      });

      return reply.send({
        success: true,
        data: updated,
        requestId: uuidv4(),
        timestamp: new Date(),
      });
    } catch (err) {
      app.log.error(err);
      return reply.status(500).send({
        success: false,
        error: "Failed to update treasury policy",
        requestId: uuidv4(),
        timestamp: new Date(),
      });
    }
  });

  // ── GET /orgs/:orgId ──────────────────────────────────────────────────────────
  app.get<{ Params: { orgId: string } }>(
    "/orgs/:orgId",
    async (request, reply) => {
      try {
        const org = await getOrg(request.params.orgId);
        if (!org) {
          return reply.status(404).send({
            success: false,
            error: "Organization not found",
            requestId: uuidv4(),
            timestamp: new Date(),
          });
        }
        return reply.send({
          success: true,
          data: org,
          requestId: uuidv4(),
          timestamp: new Date(),
        });
      } catch (err) {
        app.log.error(err);
        return reply.status(500).send({
          success: false,
          error: "Failed to fetch organization",
          requestId: uuidv4(),
          timestamp: new Date(),
        });
      }
    }
  );
};
