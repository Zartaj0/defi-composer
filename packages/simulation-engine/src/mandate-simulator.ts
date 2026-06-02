// ============================================================
// MandateSimulator
// Runs fork simulations tied to a specific mandate version.
//
// Execution modes:
//   FORK_MODE=true  (default)
//     - Spawns Anvil fork of Base
//     - Uses ephemeral test wallets
//     - No real keys, no real Safe API
//     - Records as execution_mode: "fork"
//
//   FORK_MODE=false
//     - Requires real EXECUTOR_PRIVATE_KEY + Safe API
//     - Creates Safe Transaction Service proposals
//     - Records as execution_mode: "production_proposal"
//     - NOT implemented in V1 — throws if requested
//
// Every simulation produces a SimulationArtifact with:
//   - forkBlockNumber, validUntilBlock, calldataHash
//   - balancesBefore, balancesAfter, expectedDeltas
//   - pass/fail + reason
// ============================================================

import { v4 as uuidv4 } from "uuid";
import { parseUnits } from "viem";
import {
  startFork,
  hashCalldata,
  getActiveChainId,
  type ForkSession,
} from "./fork-context.js";
import { simulateAaveSupply, type AaveSupplyParams } from "./playbooks/aave-supply.js";
import { simulateAaveWithdraw, type AaveWithdrawParams } from "./playbooks/aave-withdraw.js";
import { simulateUniswapWethToUsdc, type UniswapSwapParams } from "./playbooks/uniswap-swap.js";
import { simulateMorphoDeposit, simulateMorphoWithdraw, type MorphoDepositParams, type MorphoWithdrawParams } from "./playbooks/morpho-deposit.js";
import { amountUsdFromAsset } from "./oracles/chainlink.js";

// ─── Execution mode ───────────────────────────────────────────
export type ExecutionMode = "fork" | "production_proposal";

function getExecutionMode(): ExecutionMode {
  const forkMode = process.env["FORK_MODE"];
  // Default to fork mode — production proposal requires explicit opt-in
  if (forkMode === "false" || forkMode === "0") {
    return "production_proposal";
  }
  return "fork";
}

// ─── Mandate policy types (subset used for simulation) ────────
export interface MandatePolicy {
  mandateVersionId: string;
  approvedAssets: string[];
  approvedProtocols: string[];
  approvedActions: string[];
  blockedActions: string[];
  maxSlippageBps: number;
  maxSingleActionUsd?: number;
  reserveFloorUsd: number;
}

// ─── Playbook types ───────────────────────────────────────────
export type PlaybookName =
  | "aave_supply_usdc"
  | "aave_supply_weth"
  | "aave_withdraw_usdc"
  | "aave_withdraw_weth"
  | "uniswap_weth_to_usdc"
  | "morpho_deposit_usdc"
  | "morpho_withdraw_usdc";

export interface PlaybookRequest {
  playbook: PlaybookName;
  mandate: MandatePolicy;
  params: {
    amountHuman: string;
    onBehalfOf?: `0x${string}`;   // override test wallet if provided
    recipient?: `0x${string}`;
  };
  observedState?: {
    liquidUsd: number;
  };
  decisionId?: string;
  orgId: string;
}

// ─── Simulation artifact (matches DB schema) ──────────────────
export interface SimulationArtifact {
  id: string;
  orgId: string;
  decisionId: string | null;
  mandateVersionId: string;
  chainId: number;
  forkBlockNumber: number;
  validUntilBlock: number;
  rpcSource: string;
  calldataHash: string;
  inputCalldata: Array<Record<string, unknown>>;
  balancesBefore: Record<string, unknown>;
  balancesAfter: Record<string, unknown>;
  expectedDeltas: Record<string, unknown>;
  gasEstimate: number;
  status: "passed" | "failed" | "expired";
  failureReason: string | null;
  executionMode: ExecutionMode;
  createdAt: Date;
}

// ─── Policy checks ────────────────────────────────────────────
function enforceMandatePolicy(
  playbook: PlaybookName,
  mandate: MandatePolicy,
  amountUsd: number | null,
  observedLiquidUsd?: number
): string | null {
  const [protocol, action] = playbookToProtocolAction(playbook);

  if (!mandate.approvedProtocols.includes(protocol)) {
    return `Protocol '${protocol}' is not in mandate approvedProtocols`;
  }

  if (!mandate.approvedActions.includes(action)) {
    return `Action '${action}' is not in mandate approvedActions`;
  }

  if (mandate.blockedActions.includes(action)) {
    return `Action '${action}' is explicitly blocked by mandate`;
  }

  if (mandate.maxSingleActionUsd && amountUsd !== null && amountUsd > mandate.maxSingleActionUsd) {
    return `Amount $${amountUsd.toFixed(2)} exceeds mandate maxSingleActionUsd $${mandate.maxSingleActionUsd}`;
  }

  // Check asset
  const asset = playbookAsset(playbook);
  if (!mandate.approvedAssets.includes(asset)) {
    return `Asset '${asset}' is not in mandate approvedAssets`;
  }

  if (mandate.reserveFloorUsd > 0 && observedLiquidUsd === undefined) {
    return "Observed liquid treasury value is required to enforce reserveFloorUsd";
  }

  if (
    amountUsd !== null &&
    observedLiquidUsd !== undefined &&
    action === "supply" &&
    observedLiquidUsd - amountUsd < mandate.reserveFloorUsd
  ) {
    return (
      `Action would breach reserve floor: liquidUsdAfter=$${(observedLiquidUsd - amountUsd).toFixed(2)} ` +
      `reserveFloorUsd=$${mandate.reserveFloorUsd.toFixed(2)}`
    );
  }

  if (
    amountUsd !== null &&
    observedLiquidUsd !== undefined &&
    action === "swap" &&
    observedLiquidUsd - ((amountUsd * mandate.maxSlippageBps) / 10_000) < mandate.reserveFloorUsd
  ) {
    return (
      `Swap worst-case slippage could breach reserve floor: ` +
      `liquidUsdAfterWorstCase=$${(observedLiquidUsd - ((amountUsd * mandate.maxSlippageBps) / 10_000)).toFixed(2)} ` +
      `reserveFloorUsd=$${mandate.reserveFloorUsd.toFixed(2)}`
    );
  }

  if (
    observedLiquidUsd !== undefined &&
    action === "swap" &&
    observedLiquidUsd < mandate.reserveFloorUsd
  ) {
    return (
      `Current liquid treasury value $${observedLiquidUsd.toFixed(2)} is already below ` +
      `reserveFloorUsd $${mandate.reserveFloorUsd.toFixed(2)}`
    );
  }

  return null;
}

function playbookToProtocolAction(playbook: PlaybookName): [string, string] {
  switch (playbook) {
    case "aave_supply_usdc":
    case "aave_supply_weth":
      return ["aave-v3", "supply"];
    case "aave_withdraw_usdc":
    case "aave_withdraw_weth":
      return ["aave-v3", "withdraw"];
    case "uniswap_weth_to_usdc":
      return ["uniswap-v3", "swap"];
    case "morpho_deposit_usdc":
      return ["morpho", "deposit"];
    case "morpho_withdraw_usdc":
      return ["morpho", "withdraw"];
  }
}

function playbookAsset(playbook: PlaybookName): "USDC" | "WETH" {
  switch (playbook) {
    case "aave_supply_usdc":
    case "aave_withdraw_usdc":
    case "morpho_deposit_usdc":
    case "morpho_withdraw_usdc":
      return "USDC";
    case "aave_supply_weth":
    case "aave_withdraw_weth":
    case "uniswap_weth_to_usdc":
      return "WETH";
  }
}

function usdToUsdcUnits(usd: number): bigint {
  if (!Number.isFinite(usd) || usd <= 0) return 0n;
  return parseUnits(usd.toFixed(6), 6);
}

// ─── Main simulator ───────────────────────────────────────────
export class MandateSimulator {
  private mode: ExecutionMode;

  constructor() {
    this.mode = getExecutionMode();
    console.log(`[Simulator] Execution mode: ${this.mode}`);
  }

  async run(request: PlaybookRequest): Promise<SimulationArtifact> {
    // Always run a fork simulation — it produces the calldata proof.
    // In production_proposal mode the executor uses the artifact calldata
    // to submit a Safe proposal; in fork mode it creates a fork position.
    return this.runOnFork(request);
  }

  private async runOnFork(request: PlaybookRequest): Promise<SimulationArtifact> {
    const { playbook, mandate, params, observedState, decisionId, orgId } = request;
    const rpcSource = process.env["BASE_RPC_URL"] ?? "https://mainnet.base.org";

    const staticPolicyViolation = enforceMandatePolicy(
      playbook,
      mandate,
      null,
      observedState?.liquidUsd
    );
    if (staticPolicyViolation) {
      return failedArtifact({
        id: uuidv4(),
        orgId,
        decisionId: decisionId ?? null,
        mandateVersionId: mandate.mandateVersionId,
        rpcSource,
        reason: `POLICY_BLOCKED: ${staticPolicyViolation}`,
      });
    }

    // ── Start fork ─────────────────────────────────────────────
    // Any USDC playbook needs funding; withdraw/morpho_withdraw need 2x (deposit first)
    const needsUsdc = [
      "aave_supply_usdc",
      "aave_withdraw_usdc",
      "morpho_deposit_usdc",
      "morpho_withdraw_usdc",
    ].includes(playbook);
    const needsWeth = ["aave_supply_weth", "aave_withdraw_weth", "uniswap_weth_to_usdc"].includes(playbook);

    const requestedUsdcFunding = needsUsdc ? parseUnits(params.amountHuman, 6) * 2n : 0n;
    const observedUsdcFunding = needsUsdc ? usdToUsdcUnits(observedState?.liquidUsd ?? 0) : 0n;
    const fundUsdcAmount =
      requestedUsdcFunding > observedUsdcFunding ? requestedUsdcFunding : observedUsdcFunding;
    const fundWethAmount = needsWeth ? parseUnits(params.amountHuman, 18) * 2n : 0n;

    let fork: ForkSession | null = null;
    try {
      fork = await startFork({ fundUsdcAmount, fundWethAmount });

      let amountUsd: number;
      try {
        amountUsd = await amountUsdFromAsset(
          fork.publicClient,
          playbookAsset(playbook),
          params.amountHuman
        );
      } catch (err) {
        return failedArtifact({
          id: uuidv4(),
          orgId,
          decisionId: decisionId ?? null,
          mandateVersionId: mandate.mandateVersionId,
          rpcSource,
          reason: `ORACLE_BLOCKED: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // ── Pre-simulation policy enforcement ───────────────────
      const policyViolation = enforceMandatePolicy(
        playbook,
        mandate,
        amountUsd,
        observedState?.liquidUsd
      );
      if (policyViolation) {
        return failedArtifact({
          id: uuidv4(),
          orgId,
          decisionId: decisionId ?? null,
          mandateVersionId: mandate.mandateVersionId,
          rpcSource,
          reason: `POLICY_BLOCKED: ${policyViolation}`,
        });
      }

      // `address` is the Safe/treasury address — used as onBehalfOf/to in calldata.
      // `walletAddress` is the fork test wallet — always used as the actual signer.
      const address = params.onBehalfOf ?? params.recipient ?? fork.wallet.address;
      const walletAddress = fork.wallet.address;

      // ── Execute playbook ───────────────────────────────────
      let result;

      switch (playbook) {
        case "aave_supply_usdc": {
          const p: AaveSupplyParams = {
            asset: "USDC",
            amountHuman: params.amountHuman,
            onBehalfOf: address,       // Safe/treasury — aUSDC credited here
            signerAddress: walletAddress,  // fork wallet signs
            mandateVersionId: mandate.mandateVersionId,
          };
          result = await simulateAaveSupply(fork.publicClient, fork.walletClient, p);
          break;
        }
        case "aave_supply_weth": {
          const p: AaveSupplyParams = {
            asset: "WETH",
            amountHuman: params.amountHuman,
            onBehalfOf: address,
            signerAddress: walletAddress,
            mandateVersionId: mandate.mandateVersionId,
          };
          result = await simulateAaveSupply(fork.publicClient, fork.walletClient, p);
          break;
        }
        case "aave_withdraw_usdc": {
          // Setup: supply to fork wallet so it has aUSDC to withdraw from its OWN position.
          // We keep onBehalfOf=walletAddress for the setup because aave-withdraw.ts checks
          // the signer's aToken balance (signerAddress), not `to`.
          const supplyAmountUsdc = (parseFloat(params.amountHuman) * 2).toFixed(6);
          await simulateAaveSupply(fork.publicClient, fork.walletClient, {
            asset: "USDC",
            amountHuman: supplyAmountUsdc,
            onBehalfOf: walletAddress,   // setup: fork wallet accumulates aUSDC
            signerAddress: walletAddress,
            mandateVersionId: mandate.mandateVersionId,
          });
          // Actual withdraw: fork wallet signs, USDC sent to Safe/treasury address.
          const p: AaveWithdrawParams = {
            asset: "USDC",
            amountHuman: params.amountHuman,
            to: address,               // Safe/treasury receives USDC
            signerAddress: walletAddress,
            mandateVersionId: mandate.mandateVersionId,
          };
          result = await simulateAaveWithdraw(fork.publicClient, fork.walletClient, p);
          break;
        }
        case "aave_withdraw_weth": {
          const supplyAmountWeth = (parseFloat(params.amountHuman) * 2).toFixed(18);
          await simulateAaveSupply(fork.publicClient, fork.walletClient, {
            asset: "WETH",
            amountHuman: supplyAmountWeth,
            onBehalfOf: walletAddress,   // setup: fork wallet accumulates aWETH
            signerAddress: walletAddress,
            mandateVersionId: mandate.mandateVersionId,
          });
          const p: AaveWithdrawParams = {
            asset: "WETH",
            amountHuman: params.amountHuman,
            to: address,               // Safe/treasury receives WETH
            signerAddress: walletAddress,
            mandateVersionId: mandate.mandateVersionId,
          };
          result = await simulateAaveWithdraw(fork.publicClient, fork.walletClient, p);
          break;
        }
        case "uniswap_weth_to_usdc": {
          const p: UniswapSwapParams = {
            amountInHuman: params.amountHuman,
            recipient: address,        // Safe/treasury receives USDC
            signerAddress: walletAddress,
            maxSlippageBps: mandate.maxSlippageBps,
            mandateVersionId: mandate.mandateVersionId,
          };
          result = await simulateUniswapWethToUsdc(fork.publicClient, fork.walletClient, p);
          break;
        }
        case "morpho_deposit_usdc": {
          const p: MorphoDepositParams = {
            asset: "USDC",
            amountHuman: params.amountHuman,
            onBehalfOf: address,       // Safe/treasury receives vault shares
            signerAddress: walletAddress,
            mandateVersionId: mandate.mandateVersionId,
          };
          result = await simulateMorphoDeposit(fork.publicClient, fork.walletClient, p);
          break;
        }
        case "morpho_withdraw_usdc": {
          const p: MorphoWithdrawParams = {
            asset: "USDC",
            amountHuman: params.amountHuman,
            onBehalfOf: walletAddress, // setup: fork wallet accumulates shares
            signerAddress: walletAddress,
            mandateVersionId: mandate.mandateVersionId,
          };
          result = await simulateMorphoWithdraw(fork.publicClient, fork.walletClient, p);
          break;
        }
        default: {
          const _exhaustive: never = playbook;
          throw new Error(`Unknown playbook: ${String(_exhaustive)}`);
        }
      }

      // ── Build artifact ─────────────────────────────────────
      const calldataForHash = result.calldata.map(c => ({
        to: c.to,
        data: c.data,
        value: c.value ?? "0x0",
      }));

      const artifact: SimulationArtifact = {
        id: uuidv4(),
        orgId,
        decisionId: decisionId ?? null,
        mandateVersionId: mandate.mandateVersionId,
        chainId: fork.chainId,
        forkBlockNumber: Number(fork.forkBlockNumber),
        validUntilBlock: Number(fork.validUntilBlock),
        rpcSource,
        calldataHash: hashCalldata(calldataForHash),
        inputCalldata: result.calldata as unknown as Array<Record<string, unknown>>,
        balancesBefore: result.balancesBefore,
        balancesAfter: result.balancesAfter,
        expectedDeltas: result.expectedDeltas,
        gasEstimate: Number(result.gasEstimate),
        status: result.passed ? "passed" : "failed",
        failureReason: result.failureReason ?? null,
        executionMode: "fork",
        createdAt: new Date(),
      };

      console.log(
        `[Simulator] ${playbook} ${result.passed ? "PASSED" : "FAILED"} ` +
        `block=${fork.forkBlockNumber} validUntil=${fork.validUntilBlock} ` +
        `gas=${result.gasEstimate.toString()}`
      );

      return artifact;

    } finally {
      fork?.stop();
    }
  }
}

function failedArtifact(opts: {
  id: string;
  orgId: string;
  decisionId: string | null;
  mandateVersionId: string;
  rpcSource: string;
  reason: string;
}): SimulationArtifact {
  return {
    id: opts.id,
    orgId: opts.orgId,
    decisionId: opts.decisionId,
    mandateVersionId: opts.mandateVersionId,
    chainId: getActiveChainId(),
    forkBlockNumber: 0,
    validUntilBlock: 0,
    rpcSource: opts.rpcSource,
    calldataHash: "0x",
    inputCalldata: [],
    balancesBefore: {},
    balancesAfter: {},
    expectedDeltas: {},
    gasEstimate: 0,
    status: "failed",
    failureReason: opts.reason,
    executionMode: "fork",
    createdAt: new Date(),
  };
}

export const mandateSimulator = new MandateSimulator();
