import type {
  UserIntent,
  CandidateStrategy,
  StrategyGraph,
  RiskScore,
} from "@defi-composer/shared";
import { protocolRegistry } from "@defi-composer/protocol-adapters";
import { STRATEGY_TEMPLATES, propagateRisk, type LiveApySnapshot } from "../graph/StrategyGraph.js";
import { LLMClient } from "../llm-client.js";

// ─── Strategy Planner ────────────────────────────────────────
// This is where AI reasoning happens — and ONLY here.
// The LLM:
//   1. Understands user intent
//   2. Selects and composes strategy graphs
//   3. Explains tradeoffs
//   4. Ranks candidates
//
// The LLM does NOT:
//   - Generate transaction calldata
//   - Directly interact with protocols
//   - Make execution decisions

export class StrategyPlanner {
  private client: LLMClient | null;
  private lastGenerationInfo: {
    provider: string;
    model: string;
  } = {
    provider: "deterministic",
    model: "deterministic",
  };

  constructor() {
    try {
      this.client = LLMClient.create("planning");
    } catch {
      console.warn("[Planner] No LLM API key found — will use deterministic strategy selection");
      this.client = null;
    }
  }

  async generateCandidates(intent: UserIntent): Promise<CandidateStrategy[]> {
    // Build the protocol knowledge context for the LLM
    const protocolContext = protocolRegistry.buildLLMContext();

    // Fetch live APYs to inject into templates AND LLM context
    let liveApys: LiveApySnapshot | undefined;
    try {
      liveApys = await protocolRegistry.fetchLiveApys();
      console.log(
        `[Planner] Live APYs — Aave USDC: ${(liveApys.aave.usdc/100).toFixed(2)}%, ` +
        `Morpho Steakhouse: ${(liveApys.morpho.steakhouseUsdc/100).toFixed(2)}%`
      );
    } catch (err) {
      throw new Error(`Planner cannot generate candidates without live APYs: ${err instanceof Error ? err.message : String(err)}`);
    }

    // If no LLM client, fall back to deterministic selection
    if (!this.client) {
      console.log("[Planner] Using deterministic strategy selection (no LLM key)");
      this.lastGenerationInfo = {
        provider: "deterministic",
        model: "deterministic",
      };
      return this.selectDeterministic(intent, liveApys);
    }

    // Get live market data to inject into context
    const marketSnapshot = await this.fetchMarketSnapshot();

    const systemPrompt = `
You are the Strategy Planner for an autonomous DeFi strategy composition system.
Your job is to analyze a user's investment intent and select the best matching strategies
from the available protocol universe.

You have deep knowledge of DeFi protocols. You reason carefully about:
- APY tradeoffs vs risk
- Liquidity risk and when capital should remain in reserve
- Protocol maturity and smart contract risk
- Gas cost drag on smaller positions
- Whether the user's constraints are satisfiable

AVAILABLE PROTOCOLS:
${protocolContext}

LIVE MARKET DATA:
${marketSnapshot}

LIVE APY SNAPSHOT (fetched just now from chain/APIs):
- Aave V3 USDC supply APY: ${liveApys ? (liveApys.aave.usdc/100).toFixed(2) : "~4.5"}%
- Aave V3 WETH supply APY: ${liveApys ? (liveApys.aave.weth/100).toFixed(2) : "~1.1"}%
- Aave V3 cbETH supply APY: ${liveApys ? (liveApys.aave.cbEth/100).toFixed(2) : "~0.8"}%
- Morpho Steakhouse USDC APY: ${liveApys ? (liveApys.morpho.steakhouseUsdc/100).toFixed(2) : "~5.0"}%

AVAILABLE STRATEGY TEMPLATES:
1. conservativeStableLending — Supply USDC to Morpho Steakhouse (${liveApys ? (liveApys.morpho.steakhouseUsdc/100).toFixed(2) : "~5.0"}% APY, no liquidation risk)
2. aaveUsdcLending — Supply USDC to Aave V3 (${liveApys ? (liveApys.aave.usdc/100).toFixed(2) : "~4.5"}% APY, most liquid, instant withdrawal)
3. aaveWethLending — Supply WETH to Aave V3 (${liveApys ? (liveApys.aave.weth/100).toFixed(2) : "~1.1"}% APY, for ETH holders, no stablecoin exposure)

IMPORTANT RULES:
- Only recommend strategies that satisfy the user's constraints
- Do not recommend leverage, LP, or governance-token reward strategies in V1
- Always recommend 2-3 candidates ranked by fit with user intent
- Be honest about risks — do not sugarcoat
- Explain yield sources clearly
- For USDC/stablecoin goals: consider conservativeStableLending and aaveUsdcLending
- For ETH holders who don't want to sell: consider aaveWethLending
- If WETH must be converted to USDC for reserve or spend needs, say that swap-only Uniswap support is a separate execution playbook, not a yield strategy

Respond with a JSON array of strategy recommendations. Each item:
{
  "templateKey": "conservativeStableLending" | "aaveUsdcLending" | "aaveWethLending",
  "rank": 1 | 2 | 3,
  "recommended": true | false,
  "name": "human readable name",
  "tagline": "one line pitch",
  "aiRationale": "2-3 sentence explanation of why this strategy fits this user's goals and constraints. Be specific.",
  "fitScore": 0-100
}
`.trim();

    const userMessage = `
User Intent:
- Raw input: "${intent.rawInput}"
- Goal: ${intent.goal}
- Primary asset: ${intent.primaryAsset}
- Capital: $${intent.capitalUsd.toLocaleString()}
- Risk tolerance: ${intent.riskTolerance}
- Max drawdown allowed: ${intent.maxDrawdownPct}%
- Allow leverage: ${intent.allowLeverage}
- Allow liquidation risk: ${intent.allowLiquidationRisk}
- Allow governance tokens: ${intent.allowGovernanceTokens}
- Liquidity preference: ${intent.liquidityPreference}
- Additional constraints: ${intent.constraints.join(", ") || "none"}

Select the best 3 strategies for this user. Rank them 1 (best fit) to 3. Return JSON array only.
`.trim();

    let jsonMatch: RegExpMatchArray | null = null;
    try {
      const response = await this.client!.complete(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        {
          maxTokens: 2048,
          validate: (text) => {
            const match = text.match(/\[[\s\S]*\]/);
            if (!match?.[0]) {
              throw new Error(`Failed to parse strategy JSON. Raw: ${text.slice(0, 200)}`);
            }
            JSON.parse(match[0]);
          },
        }
      );

      console.log(
        `[Planner] LLM response via ${response.provider} (${response.model}) ` +
          `— ${response.outputTokens ?? "?"} output tokens`
      );
      this.lastGenerationInfo = {
        provider: response.provider,
        model: response.model,
      };

      jsonMatch = response.text.match(/\[[\s\S]*\]/);
      if (!jsonMatch?.[0]) {
        throw new Error(`Failed to parse strategy JSON from ${response.provider}. Raw: ${response.text.slice(0, 200)}`);
      }
    } catch (err) {
      console.warn("[Planner] LLM call failed, falling back to deterministic selection:", err instanceof Error ? err.message : err);
      this.lastGenerationInfo = {
        provider: "deterministic",
        model: "deterministic",
      };
      return this.selectDeterministic(intent, liveApys);
    }

    type LLMRecommendation = {
      templateKey: keyof typeof STRATEGY_TEMPLATES;
      rank: number;
      recommended: boolean;
      name: string;
      tagline: string;
      aiRationale: string;
      fitScore: number;
    };

    const recommendations: LLMRecommendation[] = JSON.parse(jsonMatch![0]);

    // Build CandidateStrategy objects
    const candidates: CandidateStrategy[] = [];

    for (const rec of recommendations) {
      const templateFn = STRATEGY_TEMPLATES[rec.templateKey];
      if (!templateFn) {
        console.warn(`[Planner] Unknown template key: ${rec.templateKey}`);
        continue;
      }

      const graph: StrategyGraph = templateFn(liveApys);
      const normalizedName = rec.name?.trim();
      const normalizedTagline = rec.tagline?.trim();
      const name =
        !normalizedName || normalizedName === rec.templateKey
          ? graph.name
          : normalizedName;
      const tagline = normalizedTagline || graph.description;

      // Compute deterministic risk score (never trust LLM for this)
      const riskScore = this.computeRiskScore(graph, intent);

      candidates.push({
        id: `${intent.id}-${rec.templateKey}-${Date.now()}`,
        intentId: intent.id,
        name,
        tagline,
        graph,
        riskScore,
        aiRationale: rec.aiRationale,
        rank: rec.rank,
        recommended: rec.recommended,
      });
    }

    // Sort by rank
    return candidates.sort((a, b) => a.rank - b.rank);
  }

  getLastGenerationInfo(): { provider: string; model: string } {
    return this.lastGenerationInfo;
  }

  // Rule-based strategy selection when no LLM is available
  private selectDeterministic(intent: UserIntent, liveApys?: LiveApySnapshot): CandidateStrategy[] {
    type Rec = { templateKey: keyof typeof STRATEGY_TEMPLATES; rank: number; name: string; tagline: string; rationale: string };

    const isUSDC = intent.primaryAsset === "USDC";
    const isConservative = intent.riskTolerance === "conservative";
    const isModerate = intent.riskTolerance === "moderate";

    let picks: Rec[];

    if (!isUSDC && !isConservative) {
      picks = [
        { templateKey: "aaveWethLending", rank: 1, name: "Aave WETH Lending", tagline: "Earn yield on ETH without selling", rationale: "Hold ETH exposure while earning lending yield. No stablecoin conversion needed." },
        { templateKey: "aaveUsdcLending", rank: 2, name: "Aave USDC Lending", tagline: "USDC reserve option after conversion", rationale: "If your mandate requires USDC liquidity, swap-only conversion can precede Aave supply." },
        { templateKey: "conservativeStableLending", rank: 3, name: "Morpho Steakhouse USDC", tagline: "Stablecoin alternative", rationale: "If your mandate allows conversion to USDC, this is the higher-yield lending option." },
      ];
    } else if (isModerate && isUSDC) {
      picks = [
        { templateKey: "conservativeStableLending", rank: 1, name: "Morpho Steakhouse USDC", tagline: "Highest stablecoin yield, no liquidation risk", rationale: "Best risk-adjusted yield for USDC. Morpho's vault architecture reduces protocol risk." },
        { templateKey: "aaveUsdcLending", rank: 2, name: "Aave USDC Lending", tagline: "Instant liquidity, slightly lower yield", rationale: "Aave is the most battle-tested protocol on Base with instant withdrawals." },
        { templateKey: "aaveWethLending", rank: 3, name: "Aave WETH Lending", tagline: "ETH-denominated reserve option", rationale: "Useful only if the mandate holds WETH and does not require conversion to USDC." },
      ];
    } else {
      // Default: conservative USDC
      picks = [
        { templateKey: "conservativeStableLending", rank: 1, name: "Morpho Steakhouse USDC", tagline: "Highest stablecoin yield, no liquidation risk", rationale: "Best match for conservative yield on USDC. Morpho Steakhouse is the safest high-yield vault on Base." },
        { templateKey: "aaveUsdcLending", rank: 2, name: "Aave V3 USDC Lending", tagline: "Instant liquidity, battle-tested", rationale: "Slightly lower yield than Morpho but with instant withdrawal and the most audited codebase in DeFi." },
        { templateKey: "aaveWethLending", rank: 3, name: "Aave WETH Lending", tagline: "ETH-denominated yield option", rationale: "If you hold any ETH, this earns yield without selling into stablecoins." },
      ];
    }

    return picks.map((p) => {
      const templateFn = STRATEGY_TEMPLATES[p.templateKey];
      const graph = templateFn(liveApys);
      const riskScore = this.computeRiskScore(graph, intent);
      return {
        id: `${intent.id}-${p.templateKey}-${Date.now()}`,
        intentId: intent.id,
        name: p.name,
        tagline: p.tagline,
        graph,
        riskScore,
        aiRationale: p.rationale,
        rank: p.rank,
        recommended: p.rank === 1,
      };
    });
  }

  // Deterministic risk scoring — independent of LLM
  private computeRiskScore(
    graph: StrategyGraph,
    intent: UserIntent
  ): RiskScore {
    const propagatedRisks = propagateRisk(graph);

    const severityScore = { low: 2, medium: 5, high: 8 };
    const riskTypeWeight = {
      liquidation: 2.5,
      smart_contract: 1.5,
      oracle: 2.0,
      impermanent_loss: 1.2,
      liquidity: 1.8,
    };

    let weightedSum = 0;
    let totalWeight = 0;
    const breakdown = [];

    for (const risk of propagatedRisks) {
      const base = severityScore[risk.severity] ?? 3;
      const weight = riskTypeWeight[risk.type] ?? 1.0;
      weightedSum += base * weight;
      totalWeight += weight;

      breakdown.push({
        factor: risk.type,
        score: base,
        weight,
        contribution: (base * weight) / 10,
        description: risk.description,
      });
    }

    const rawScore = totalWeight > 0 ? weightedSum / totalWeight : 1;
    const overall = Math.min(Math.max(rawScore, 0), 10);

    const riskLevel =
      overall < 2
        ? ("very_low" as const)
        : overall < 4
        ? ("low" as const)
        : overall < 6
        ? ("medium" as const)
        : overall < 8
        ? ("high" as const)
        : ("very_high" as const);

    const warnings: string[] = [];
    const blockers: string[] = [];

    // Check against user constraints
    const hasLiquidationRisk = propagatedRisks.some(
      (r) => r.type === "liquidation"
    );
    if (hasLiquidationRisk && !intent.allowLiquidationRisk) {
      blockers.push(
        "This strategy has liquidation risk, which you explicitly excluded."
      );
    }

    const v1YieldProtocols = new Set(["aave-v3", "morpho-blue"]);
    const unsupportedProtocols = [
      ...new Set(
        graph.nodes
          .map((n) => n.protocol)
          .filter((protocol): protocol is NonNullable<typeof protocol> => Boolean(protocol))
          .filter((protocol) => !v1YieldProtocols.has(protocol))
      ),
    ];
    if (unsupportedProtocols.length > 0) {
      blockers.push(
        `Unsupported V1 yield protocol in strategy graph: ${unsupportedProtocols.join(", ")}.`
      );
    }

    if (intent.capitalUsd < 1000) {
      warnings.push(
        `Gas costs ($${graph.totalGasCostUsd.toFixed(2)}) represent ${(
          (graph.totalGasCostUsd / intent.capitalUsd) *
          100
        ).toFixed(1)}% of capital — consider a larger position.`
      );
    }

    return {
      overall: Math.round(overall * 10) / 10,
      overallLevel: riskLevel,
      marketRisk: hasLiquidationRisk ? 5 : 2,
      liquidationRisk: hasLiquidationRisk ? 6 : 0,
      protocolRisk: 2,
      liquidityRisk: 1,
      oracleRisk: hasLiquidationRisk ? 3 : 1,
      breakdown,
      warnings,
      blockers,
    };
  }

  private async fetchMarketSnapshot(): Promise<string> {
    try {
      const adapters = protocolRegistry.getAll();
      const snapshots: string[] = [];

      for (const adapter of adapters) {
        const markets = await adapter.getMarkets();
        if (markets.length > 0) {
          const marketLines = markets
            .slice(0, 3)
            .map(
              (m) =>
                `  ${m.asset}: supply ${(m.supplyApyBps / 100).toFixed(2)}% APY, borrow ${(m.borrowApyBps / 100).toFixed(2)}% APY, util ${m.utilizationPct.toFixed(0)}%`
            )
            .join("\n");
          snapshots.push(`${adapter.metadata.displayName}:\n${marketLines}`);
        }

        if (adapter.getPools) {
          const pools = await adapter.getPools();
          if (pools.length > 0) {
            const poolLines = pools
              .slice(0, 3)
              .map(
                (p) =>
                  `  ${p.token0}/${p.token1}: ${(p.totalApyBps / 100).toFixed(2)}% total APY (${(p.feeApyBps / 100).toFixed(2)}% fees + ${(p.rewardApyBps / 100).toFixed(2)}% rewards), TVL $${(p.tvlUsd / 1e6).toFixed(1)}M`
              )
              .join("\n");
            snapshots.push(`${adapter.metadata.displayName} Pools:\n${poolLines}`);
          }
        }
      }

      return snapshots.join("\n\n") || "Market data unavailable";
    } catch (err) {
      console.error("[Planner] Failed to fetch market snapshot:", err);
      return "Market data temporarily unavailable";
    }
  }
}
