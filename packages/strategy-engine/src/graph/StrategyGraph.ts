import type {
  StrategyGraph,
  StrategyNode,
  StrategyEdge,
  RiskScore,
  NodeRisk,
} from "@defi-composer/shared";

// ─── Graph Operations ────────────────────────────────────────
// The core data structure. Strategies are DAGs.
// Each node is a protocol action. Edges are capital flows.
// Risk propagates through the graph from leaf to root.

export class StrategyGraphBuilder {
  private nodes: StrategyNode[] = [];
  private edges: StrategyEdge[] = [];
  private id: string;
  private name: string;
  private description: string;

  constructor(id: string, name: string, description: string) {
    this.id = id;
    this.name = name;
    this.description = description;
  }

  addNode(node: StrategyNode): this {
    if (this.nodes.find((n) => n.id === node.id)) {
      throw new Error(`Node with id '${node.id}' already exists`);
    }
    this.nodes.push(node);
    return this;
  }

  addEdge(edge: StrategyEdge): this {
    const from = this.nodes.find((n) => n.id === edge.from);
    const to = this.nodes.find((n) => n.id === edge.to);
    if (!from) throw new Error(`Edge source node '${edge.from}' not found`);
    if (!to) throw new Error(`Edge target node '${edge.to}' not found`);
    this.edges.push(edge);
    return this;
  }

  build(): StrategyGraph {
    this.validateDAG();
    const ordered = this.topologicalSort();

    const estimatedApyBps = this.computeCompositeApy(ordered);
    const totalGasCostUsd = this.nodes.reduce(
      (sum, n) => sum + n.gasCostUsd,
      0
    );

    return {
      id: this.id,
      name: this.name,
      description: this.description,
      nodes: ordered,
      edges: this.edges,
      entryAsset: ordered[0]?.inputAsset ?? "USDC",
      exitAsset: ordered[ordered.length - 1]?.outputAsset ?? "USDC",
      estimatedApyBps,
      totalGasCostUsd,
      createdAt: new Date(),
    };
  }

  // Kahn's algorithm — topological sort for execution ordering
  private topologicalSort(): StrategyNode[] {
    const inDegree: Map<string, number> = new Map(
      this.nodes.map((n) => [n.id, 0])
    );

    for (const edge of this.edges) {
      inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    }

    const queue: StrategyNode[] = this.nodes.filter(
      (n) => (inDegree.get(n.id) ?? 0) === 0
    );
    const result: StrategyNode[] = [];

    while (queue.length > 0) {
      const node = queue.shift()!;
      result.push(node);

      const outEdges = this.edges.filter((e) => e.from === node.id);
      for (const edge of outEdges) {
        const newDegree = (inDegree.get(edge.to) ?? 0) - 1;
        inDegree.set(edge.to, newDegree);
        if (newDegree === 0) {
          const nextNode = this.nodes.find((n) => n.id === edge.to);
          if (nextNode) queue.push(nextNode);
        }
      }
    }

    return result;
  }

  // Detect cycles — invalid for execution ordering
  private validateDAG(): void {
    const visited = new Set<string>();
    const inStack = new Set<string>();

    const hasCycle = (nodeId: string): boolean => {
      visited.add(nodeId);
      inStack.add(nodeId);

      const outEdges = this.edges.filter((e) => e.from === nodeId);
      for (const edge of outEdges) {
        if (!visited.has(edge.to)) {
          if (hasCycle(edge.to)) return true;
        } else if (inStack.has(edge.to)) {
          return true;
        }
      }

      inStack.delete(nodeId);
      return false;
    };

    for (const node of this.nodes) {
      if (!visited.has(node.id)) {
        if (hasCycle(node.id)) {
          throw new Error(
            `Strategy graph contains a cycle involving node '${node.id}'. Strategies must be DAGs.`
          );
        }
      }
    }
  }

  // Composite APY across sequential nodes
  // For parallel branches, we weight by capital allocation
  private computeCompositeApy(orderedNodes: StrategyNode[]): number {
    if (orderedNodes.length === 0) return 0;

    // Simple model: APY compounds through the chain
    // In reality this needs capital allocation tracking
    let compositeApy = 0;
    for (const node of orderedNodes) {
      if (node.action === "supply" || node.action === "add_liquidity" || node.action === "stake") {
        compositeApy += node.expectedApyBps;
      }
    }

    return compositeApy;
  }
}

// ─── Risk Propagation ────────────────────────────────────────
// Propagates risk through the graph — a node inherits risk from its parents
// because if a parent action fails, downstream actions fail too

export function propagateRisk(graph: StrategyGraph): NodeRisk[] {
  const allRisks: NodeRisk[] = [];
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));

  // BFS from root nodes
  for (const node of graph.nodes) {
    // Inherit risks from parent nodes
    const incomingEdges = graph.edges.filter((e) => e.to === node.id);
    for (const edge of incomingEdges) {
      const parent = nodeMap.get(edge.from);
      if (parent) {
        // Propagate parent risks with slightly reduced severity
        for (const risk of parent.risks) {
          allRisks.push({
            ...risk,
            description: `[Inherited from ${parent.protocol}] ${risk.description}`,
          });
        }
      }
    }

    allRisks.push(...node.risks);
  }

  // Deduplicate by type, taking max severity
  const deduped = new Map<string, NodeRisk>();
  for (const risk of allRisks) {
    const key = risk.type;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, risk);
    } else {
      const severityOrder = { low: 1, medium: 2, high: 3 };
      if (
        severityOrder[risk.severity] > severityOrder[existing.severity]
      ) {
        deduped.set(key, risk);
      }
    }
  }

  return Array.from(deduped.values());
}

// Live APY snapshot injected at template instantiation time
export interface LiveApySnapshot {
  aave: { usdc: number; weth: number; cbEth: number };
  morpho: { steakhouseUsdc: number };
}

function requireApy(value: number | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Missing live APY for ${label}`);
  }
  return value;
}

// ─── Pre-built Strategy Templates ────────────────────────────
// Accept live APYs so rates are real at execution time, not stale constants.

export const STRATEGY_TEMPLATES = {
  // Strategy 1: Simple USDC lending on Morpho (conservative)
  conservativeStableLending: (apys?: Partial<LiveApySnapshot>): StrategyGraph => {
    const morphoUsdc = requireApy(apys?.morpho?.steakhouseUsdc, "Morpho Steakhouse USDC");
    return new StrategyGraphBuilder(
      "conservative-stable-lending",
      "Conservative Stable Lending",
      `Deposit USDC directly into Morpho Steakhouse vault for ~${(morphoUsdc/100).toFixed(1)}% APY. No leverage, no liquidation risk. Highest safety score.`
    )
      .addNode({
        id: "deposit-usdc",
        protocol: "morpho-blue",
        action: "supply",
        inputAsset: "USDC",
        outputAsset: "USDC",
        expectedApyBps: morphoUsdc,
        gasCostUsd: 0.8,
        risks: [
          {
            type: "smart_contract",
            severity: "low",
            description: "Morpho protocol smart contract risk (audited, $420M TVL)",
          },
        ],
        metadata: { vault: "steakhouse", version: "metamorpho" },
      })
      .build();
  },

  // Strategy 1b: Simple USDC supply on Aave V3
  aaveUsdcLending: (apys?: Partial<LiveApySnapshot>): StrategyGraph => {
    const aaveUsdc = requireApy(apys?.aave?.usdc, "Aave USDC");
    return new StrategyGraphBuilder(
      "aave-usdc-lending",
      "Aave V3 USDC Lending",
      `Supply USDC to Aave V3 on Base for ~${(aaveUsdc/100).toFixed(1)}% APY. Instant withdrawal, no leverage risk. The simplest and most liquid strategy.`
    )
      .addNode({
        id: "supply-usdc-aave",
        protocol: "aave-v3",
        action: "supply",
        inputAsset: "USDC",
        outputAsset: "USDC",
        expectedApyBps: aaveUsdc,
        gasCostUsd: 1.5,
        risks: [
          {
            type: "smart_contract",
            severity: "low",
            description: "Aave V3 Base — 6 audits, $280M TVL on Base",
          },
        ],
        metadata: { asset: "USDC", protocol: "aave-v3" },
      })
      .build();
  },

  // Strategy 1c: WETH lending on Aave
  aaveWethLending: (apys?: Partial<LiveApySnapshot>): StrategyGraph => {
    const aaveWeth = requireApy(apys?.aave?.weth, "Aave WETH");
    return new StrategyGraphBuilder(
      "aave-weth-lending",
      "Aave V3 WETH Lending",
      `Supply WETH to Aave V3 for ~${(aaveWeth/100).toFixed(1)}% APY. Ideal for ETH holders who want yield without selling. Instant withdrawal.`
    )
      .addNode({
        id: "supply-weth-aave",
        protocol: "aave-v3",
        action: "supply",
        inputAsset: "WETH",
        outputAsset: "WETH",
        expectedApyBps: aaveWeth,
        gasCostUsd: 1.5,
        risks: [
          {
            type: "smart_contract",
            severity: "low",
            description: "Aave V3 Base — 6 audits, $280M TVL on Base",
          },
        ],
        metadata: { asset: "WETH", protocol: "aave-v3" },
      })
      .build();
  },

} as const;
