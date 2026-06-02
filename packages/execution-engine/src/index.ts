import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  parseEther,
  type Hash,
  type Address,
} from "viem";
import { base } from "viem/chains";
import type { StrategyGraph, StrategyNode, Position } from "@defi-composer/shared";
import { protocolRegistry } from "@defi-composer/protocol-adapters";
import type { EncodedAction } from "@defi-composer/protocol-adapters";

// ─── ERC-20 Approve ABI ──────────────────────────────────────
const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    name: "allowance",
    type: "function",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

// ─── Execution Plan ──────────────────────────────────────────
// A fully deterministic sequence of transactions derived from a strategy graph.
// The LLM never touches this. Pure deterministic encoding.

export interface ExecutionPlan {
  strategyId: string;
  steps: ExecutionStep[];
  totalGasEstimate: bigint;
  estimatedCostUsd: number;
}

export interface ExecutionStep {
  index: number;
  nodeId: string;
  description: string;
  txType: "approve" | "action";
  action: EncodedAction;
  requiresApprovalFor?: {
    tokenAddress: Address;
    spenderAddress: Address;
    amount: bigint;
  };
}

export interface ExecutionResult {
  success: boolean;
  txHashes: Hash[];
  error?: string;
  gasUsed?: bigint;
}

// ─── Execution Engine ────────────────────────────────────────
export class ExecutionEngine {
  private publicClient = createPublicClient({
    chain: base,
    transport: http(process.env["BASE_RPC_URL"] ?? "https://mainnet.base.org"),
  });

  // ── Step 1: Build execution plan from strategy graph ──────
  // Deterministic. No AI involved. Pure encoding.
  async buildExecutionPlan(
    graph: StrategyGraph,
    capitalAmount: bigint,
    userAddress: Address,
    smartAccountAddress: Address
  ): Promise<ExecutionPlan> {
    const steps: ExecutionStep[] = [];
    let stepIndex = 0;
    let totalGasEstimate = 0n;

    for (const node of graph.nodes) {
      const adapter = protocolRegistry.get(node.protocol);
      let action: EncodedAction | null = null;

      // Build the specific action calldata
      action = await this.buildNodeAction(node, capitalAmount, smartAccountAddress, adapter);

      if (!action) continue;

      // Check if we need an approval first
      const approval = await this.checkApprovalNeeded(
        node,
        action,
        capitalAmount,
        smartAccountAddress
      );

      if (approval) {
        steps.push({
          index: stepIndex++,
          nodeId: node.id,
          description: `Approve ${node.inputAsset} for ${node.protocol}`,
          txType: "approve",
          action: approval,
          requiresApprovalFor: {
            tokenAddress: approval.to,
            spenderAddress: action.to,
            amount: capitalAmount,
          },
        });
        totalGasEstimate += 65_000n; // standard ERC20 approve
      }

      steps.push({
        index: stepIndex++,
        nodeId: node.id,
        description: action.description,
        txType: "action",
        action,
      });

      totalGasEstimate += action.gasEstimate;
    }

    // Estimate cost at 0.1 gwei base fee on Base
    const gasCostEth = Number(totalGasEstimate) * 0.1e-9;
    const gasCostUsd = gasCostEth * 3000; // ETH price estimate

    return {
      strategyId: graph.id,
      steps,
      totalGasEstimate,
      estimatedCostUsd: gasCostUsd,
    };
  }

  private async buildNodeAction(
    node: StrategyNode,
    amount: bigint,
    userAddress: Address,
    adapter: ReturnType<typeof protocolRegistry.get>
  ): Promise<EncodedAction | null> {
    try {
      switch (node.action) {
        case "supply":
          return adapter.buildSupplyCalldata
            ? await adapter.buildSupplyCalldata(node.inputAsset, amount, userAddress)
            : null;

        case "borrow":
          return adapter.buildBorrowCalldata
            ? await adapter.buildBorrowCalldata(node.inputAsset, amount, userAddress)
            : null;

        case "withdraw":
          return adapter.buildWithdrawCalldata
            ? await adapter.buildWithdrawCalldata(node.inputAsset, amount, userAddress)
            : null;

        case "add_liquidity": {
          const stable = node.metadata["stable"] as boolean | undefined ?? false;
          const half = amount / 2n;
          return adapter.buildAddLiquidityCalldata
            ? await adapter.buildAddLiquidityCalldata(
                node.inputAsset,
                node.outputAsset,
                half,
                half,
                stable,
                userAddress
              )
            : null;
        }

        default:
          console.warn(`[Execution] No calldata builder for action: ${node.action}`);
          return null;
      }
    } catch (err) {
      console.error(`[Execution] Failed to build calldata for node ${node.id}:`, err);
      return null;
    }
  }

  // Check if ERC20 approval is needed before the action
  private async checkApprovalNeeded(
    node: StrategyNode,
    action: EncodedAction,
    amount: bigint,
    userAddress: Address
  ): Promise<EncodedAction | null> {
    // Native ETH doesn't need approval
    if (node.inputAsset === "ETH") return null;

    const TOKEN_ADDRESSES: Record<string, Address> = {
      USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      WETH: "0x4200000000000000000000000000000000000006",
      cbETH: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
      wstETH: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452",
      AERO: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
    };

    const tokenAddress = TOKEN_ADDRESSES[node.inputAsset];
    if (!tokenAddress) return null;

    try {
      const allowance = await this.publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [userAddress, action.to],
      });

      if (allowance >= amount) return null; // sufficient approval exists

      // Build approve calldata
      const approveData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [action.to, amount],
      });

      return {
        protocol: node.protocol,
        to: tokenAddress,
        data: approveData,
        value: 0n,
        gasEstimate: 65_000n,
        description: `Approve ${node.inputAsset} for ${node.protocol}`,
      };
    } catch {
      // If we can't check, include approval to be safe
      const approveData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [action.to, amount],
      });

      return {
        protocol: node.protocol,
        to: tokenAddress as Address,
        data: approveData,
        value: 0n,
        gasEstimate: 65_000n,
        description: `Approve ${node.inputAsset} for ${node.protocol}`,
      };
    }
  }

  // ── Step 2: Session Key Configuration (ERC-4337) ──────────
  // Returns the Safe module config for delegating strategy execution to the agent
  buildSessionKeyConfig(
    smartAccountAddress: Address,
    _strategyGraph: StrategyGraph
  ): SessionKeyConfig {
    return {
      smartAccount: smartAccountAddress,
      allowedTargets: this.extractAllowedTargets(_strategyGraph),
      allowedSelectors: this.extractAllowedSelectors(_strategyGraph),
      spendingLimit: {
        token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
        dailyLimitUsd: 50_000,
      },
      expiryTimestamp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // 30 days
    };
  }

  private extractAllowedTargets(graph: StrategyGraph): Address[] {
    const targets = new Set<Address>();
    // In production: extract from EncodedActions
    return Array.from(targets);
  }

  private extractAllowedSelectors(graph: StrategyGraph): string[] {
    const selectors: string[] = [];
    // supply: 0x617ba037, borrow: 0xa415bcad, etc.
    for (const node of graph.nodes) {
      if (node.action === "supply") selectors.push("0x617ba037");
      if (node.action === "borrow") selectors.push("0xa415bcad");
      if (node.action === "withdraw") selectors.push("0x69328dec");
      if (node.action === "add_liquidity") selectors.push("0xe8e33700");
    }
    return [...new Set(selectors)];
  }
}

// ─── Session Key Config ──────────────────────────────────────
export interface SessionKeyConfig {
  smartAccount: Address;
  allowedTargets: Address[];
  allowedSelectors: string[];
  spendingLimit: {
    token: Address;
    dailyLimitUsd: number;
  };
  expiryTimestamp: number;
}

export const executionEngine = new ExecutionEngine();

// ─── Safe submission ──────────────────────────────────────────
export {
  submitSafeProposal,
  getSafeNonce,
  getSafeInfo,
  getSafeExecutionStatus,
  listPendingSafeProposals,
} from "./safe-submitter.js";
export type {
  SubmitProposalParams,
  SubmitProposalResult,
  SafeExecutionStatus,
} from "./safe-submitter.js";

// ─── Module executor (autonomous execution via AgentExecutorModule) ──
export {
  approveOnSafe,
  executeViaModule,
  computeApprovalHash,
  // PolicyEnforcedModule — single-phase autonomous execution
  executePolicyModule,
  isPolicyModuleEnabled,
} from "./module-executor.js";
export type {
  ApproveOnSafeResult,
  ExecuteResult,
  PolicyExecuteParams,
  PolicyExecuteResult,
} from "./module-executor.js";
