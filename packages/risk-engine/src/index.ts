import type {
  StrategyGraph,
  UserIntent,
  RiskScore,
  RiskBreakdownItem,
  RiskLevel,
} from "@defi-composer/shared";
import { propagateRisk } from "@defi-composer/strategy-engine";

// ─── Risk Engine ─────────────────────────────────────────────
// Deterministic, independent risk scoring system.
// NEVER relies on LLM output. Uses on-chain data + protocol metadata.
// This is the safety layer between AI reasoning and execution.

export class RiskEngine {
  // Full risk assessment pipeline
  async assess(
    graph: StrategyGraph,
    intent: UserIntent,
    positionValueUsd: number
  ): Promise<RiskScore> {
    const [
      marketRisk,
      liquidationRisk,
      protocolRisk,
      liquidityRisk,
      oracleRisk,
    ] = await Promise.all([
      this.scoreMarketRisk(graph),
      this.scoreLiquidationRisk(graph),
      this.scoreProtocolRisk(graph),
      this.scoreLiquidityRisk(graph, positionValueUsd),
      this.scoreOracleRisk(graph),
    ]);

    const weights = {
      market: 0.2,
      liquidation: 0.3,
      protocol: 0.2,
      liquidity: 0.15,
      oracle: 0.15,
    };

    const overall =
      marketRisk * weights.market +
      liquidationRisk * weights.liquidation +
      protocolRisk * weights.protocol +
      liquidityRisk * weights.liquidity +
      oracleRisk * weights.oracle;

    const riskLevel = this.scoreToLevel(overall);

    const breakdown: RiskBreakdownItem[] = [
      {
        factor: "Market Risk",
        score: marketRisk,
        weight: weights.market,
        contribution: marketRisk * weights.market,
        description: "Volatility and drawdown exposure of underlying assets",
      },
      {
        factor: "Liquidation Risk",
        score: liquidationRisk,
        weight: weights.liquidation,
        contribution: liquidationRisk * weights.liquidation,
        description: "Probability and impact of liquidation events",
      },
      {
        factor: "Protocol Risk",
        score: protocolRisk,
        weight: weights.protocol,
        contribution: protocolRisk * weights.protocol,
        description: "Smart contract and governance risk across protocols",
      },
      {
        factor: "Liquidity Risk",
        score: liquidityRisk,
        weight: weights.liquidity,
        contribution: liquidityRisk * weights.liquidity,
        description: "Ability to exit positions without significant slippage",
      },
      {
        factor: "Oracle Risk",
        score: oracleRisk,
        weight: weights.oracle,
        contribution: oracleRisk * weights.oracle,
        description: "Risk of oracle price manipulation affecting positions",
      },
    ];

    const warnings = this.generateWarnings(graph, intent, {
      marketRisk,
      liquidationRisk,
      protocolRisk,
      liquidityRisk,
      oracleRisk,
    });

    const blockers = this.generateBlockers(graph, intent);

    return {
      overall: Math.round(overall * 10) / 10,
      overallLevel: riskLevel,
      marketRisk: Math.round(marketRisk * 10) / 10,
      liquidationRisk: Math.round(liquidationRisk * 10) / 10,
      protocolRisk: Math.round(protocolRisk * 10) / 10,
      liquidityRisk: Math.round(liquidityRisk * 10) / 10,
      oracleRisk: Math.round(oracleRisk * 10) / 10,
      breakdown,
      warnings,
      blockers,
    };
  }

  // ─── Individual Risk Scorers ──────────────────────────────

  private async scoreMarketRisk(graph: StrategyGraph): Promise<number> {
    let score = 0;

    for (const node of graph.nodes) {
      // ETH-denominated positions have market risk
      if (
        node.inputAsset === "WETH" ||
        node.inputAsset === "cbETH" ||
        node.inputAsset === "wstETH"
      ) {
        score = Math.max(score, 4); // baseline ETH vol risk
      }

      // Stable assets have low market risk
      if (node.inputAsset === "USDC" || node.inputAsset === "DAI") {
        score = Math.max(score, 1);
      }

      // LP positions compound market risk with IL
      if (node.action === "add_liquidity") {
        const stable = node.metadata["stable"] as boolean | undefined;
        score = Math.max(score, stable ? 3 : 6);
      }

      // AERO rewards add speculative exposure
      if (node.outputAsset === "AERO") {
        score = Math.max(score, 5);
      }
    }

    return score;
  }

  private async scoreLiquidationRisk(graph: StrategyGraph): Promise<number> {
    const hasBorrow = graph.nodes.some((n) => n.action === "borrow");
    if (!hasBorrow) return 0;

    // Find the borrow node and check target LTV
    const borrowNode = graph.nodes.find((n) => n.action === "borrow");
    if (!borrowNode) return 0;

    const targetLtv = borrowNode.metadata["targetLtv"] as number | undefined;
    if (!targetLtv) return 4;

    // Score based on LTV — lower LTV = less liquidation risk
    // 20% LTV → score 1, 40% → 3, 60% → 6, 80% → 9
    return Math.min(targetLtv * 12, 9);
  }

  private async scoreProtocolRisk(graph: StrategyGraph): Promise<number> {
    const protocolScores: Record<string, number> = {
      "aave-v3": 1.5, // battle-tested, 24mo on Base, 6 audits
      "morpho-blue": 2.0, // newer but clean codebase, 4 audits
      "uniswap-v3": 1.5, // V1 swap-only reserve conversion
    };

    // Strategy risk = worst protocol in chain (weakest link)
    let maxScore = 0;
    for (const node of graph.nodes) {
      const score = protocolScores[node.protocol] ?? 3;
      maxScore = Math.max(maxScore, score);
    }

    // Multi-protocol strategies compound risk
    const uniqueProtocols = new Set(graph.nodes.map((n) => n.protocol)).size;
    const compositionPenalty = (uniqueProtocols - 1) * 0.5;

    return Math.min(maxScore + compositionPenalty, 10);
  }

  private async scoreLiquidityRisk(
    graph: StrategyGraph,
    positionValueUsd: number
  ): Promise<number> {
    let score = 0;

    for (const node of graph.nodes) {
      // LP positions: check pool depth vs position size
      if (node.action === "add_liquidity") {
        // If position > 1% of pool TVL, meaningful price impact
        // This would use real pool data in production
        score = Math.max(score, 2);
      }

      // Borrowing creates liquidity dependency
      if (node.action === "borrow") {
        score = Math.max(score, 3);
      }

      // Large positions ($100k+) increase liquidity risk
      if (positionValueUsd > 100_000) {
        score += 1;
      }
    }

    return Math.min(score, 10);
  }

  private async scoreOracleRisk(graph: StrategyGraph): Promise<number> {
    const hasBorrow = graph.nodes.some((n) => n.action === "borrow");
    // Lending protocols with borrow depend on oracles for liquidation
    if (hasBorrow) return 3;

    // Pure LP and supply positions have minimal oracle dependency
    return 1;
  }

  // ─── Warnings and Blockers ────────────────────────────────

  private generateWarnings(
    graph: StrategyGraph,
    intent: UserIntent,
    scores: Record<string, number>
  ): string[] {
    const warnings: string[] = [];

    if ((scores["liquidationRisk"] ?? 0) > 4) {
      warnings.push(
        "This strategy has non-trivial liquidation risk. Monitor health factor regularly. Target HF > 2.0."
      );
    }

    const hasAero = graph.nodes.some((n) => n.outputAsset === "AERO");
    if (hasAero && !intent.allowGovernanceTokens) {
      warnings.push(
        "AERO token rewards are governance token emissions. Their value is volatile and could be zero."
      );
    }

    const gasAsPercent =
      (graph.totalGasCostUsd / intent.capitalUsd) * 100;
    if (gasAsPercent > 1) {
      warnings.push(
        `Gas costs ($${graph.totalGasCostUsd.toFixed(2)}) are ${gasAsPercent.toFixed(1)}% of capital. Consider a larger position size.`
      );
    }

    const hasIL = graph.nodes.some((n) =>
      n.risks.some((r) => r.type === "impermanent_loss")
    );
    if (hasIL) {
      const stablePool = graph.nodes.find(
        (n) => n.metadata["stable"] === true
      );
      if (!stablePool) {
        warnings.push(
          "This strategy has impermanent loss exposure. IL can significantly reduce returns in volatile markets."
        );
      }
    }

    if ((scores["protocolRisk"] ?? 0) > 5) {
      warnings.push(
        "This strategy uses multiple protocols. A bug in any one protocol affects the entire position."
      );
    }

    return warnings;
  }

  private generateBlockers(
    graph: StrategyGraph,
    intent: UserIntent
  ): string[] {
    const blockers: string[] = [];

    const hasLiquidationRisk = graph.nodes.some((n) =>
      n.risks.some((r) => r.type === "liquidation")
    );

    if (hasLiquidationRisk && !intent.allowLiquidationRisk) {
      blockers.push(
        "Strategy requires liquidation risk which you explicitly excluded. Choose a different strategy."
      );
    }

    if (
      intent.riskTolerance === "conservative" &&
      graph.nodes.some((n) => n.action === "borrow")
    ) {
      blockers.push(
        "Borrowing is incompatible with conservative risk tolerance."
      );
    }

    return blockers;
  }

  private scoreToLevel(score: number): RiskLevel {
    if (score < 2) return "very_low";
    if (score < 4) return "low";
    if (score < 6) return "medium";
    if (score < 8) return "high";
    return "very_high";
  }
}

export const riskEngine = new RiskEngine();
