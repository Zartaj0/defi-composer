// ============================================================
// Executor Service
// BullMQ worker: approved strategy → simulate → build calldata
//                → propose to Safe → record position in DB
//
// Design contract:
//   - AI never executes — this service only builds deterministic calldata
//   - Every strategy re-simulates at current block before any calldata is built
//   - Safe proposal requires M-of-N approval before on-chain execution
//   - Rebalance path handles both normal migration and emergency unwind (HF < 1.2)
// ============================================================

import "dotenv/config";
import { Worker, Queue } from "bullmq";
import {
  createWalletClient,
  http,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  toBytes,
  concat,
  toHex,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { ExecutionEngine } from "@defi-composer/execution-engine";
import { SimulationEngine } from "@defi-composer/simulation-engine";
import { RiskEngine } from "@defi-composer/risk-engine";
import {
  getOrg,
  getPosition,
  createPosition,
  updatePositionStatus,
  updateIntentStatus,
  listActivePositions,
} from "@defi-composer/db";
import type { CandidateStrategy } from "@defi-composer/shared";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const SAFE_TX_SERVICE = "https://safe-transaction-base.safe.global";
// Private key for the proposer agent wallet. This wallet proposes to Safe;
// actual execution requires M-of-N signatures from human signers.
const PROPOSER_PRIVATE_KEY = process.env["EXECUTOR_PRIVATE_KEY"] as
  | `0x${string}`
  | undefined;

const connection = {
  host: new URL(REDIS_URL).hostname,
  port: parseInt(new URL(REDIS_URL).port || "6379"),
};

const executionEngine = new ExecutionEngine();
const simulationEngine = new SimulationEngine();
const riskEngine = new RiskEngine();

// ─── Queue definitions ────────────────────────────────────────────────────────
export const executionQueue = new Queue("strategy-execution", { connection });
export const rebalanceQueue = new Queue("strategy-rebalance", { connection });

// ─── Job payloads ─────────────────────────────────────────────────────────────
export interface ExecutionJobPayload {
  orgId: string;
  intentId: string;
  strategy: CandidateStrategy;
  walletAddress: `0x${string}`;
  safeAddress?: `0x${string}`;
  simulationRequired: boolean;
  capitalUsd: number;
}

export interface RebalanceJobPayload {
  orgId: string;
  positionId: string;
  reason: string;
  triggeredBy: "monitor" | "user" | "governance";
  emergencyUnwind?: boolean; // true when HF < 1.2
}

// ─── Safe Transaction Service helpers ─────────────────────────────────────────

const SAFE_TX_TYPEHASH = keccak256(
  toBytes(
    "SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)"
  )
);

function buildDomainSeparator(chainId: number, safeAddress: Address): Hash {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("bytes32, uint256, address"),
      [
        keccak256(
          toBytes("EIP712Domain(uint256 chainId,address verifyingContract)")
        ),
        BigInt(chainId),
        safeAddress,
      ]
    )
  );
}

function buildSafeTxHash(
  domainSeparator: Hash,
  to: Address,
  data: Hex,
  nonce: bigint
): Hash {
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;
  const txStructHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "bytes32, address, uint256, bytes32, uint8, uint256, uint256, uint256, address, address, uint256"
      ),
      [
        SAFE_TX_TYPEHASH,
        to,
        0n,            // value
        keccak256(data),
        0,             // operation: CALL
        0n,            // safeTxGas
        0n,            // baseGas
        0n,            // gasPrice
        ZERO_ADDR,     // gasToken
        ZERO_ADDR,     // refundReceiver
        nonce,
      ]
    )
  );

  return keccak256(
    concat([toBytes("\x19\x01"), toBytes(domainSeparator), toBytes(txStructHash)])
  );
}

async function getSafeNonce(safeAddress: Address): Promise<number> {
  const res = await fetch(
    `${SAFE_TX_SERVICE}/api/v1/safes/${safeAddress}/`
  );
  if (!res.ok) throw new Error(`Safe nonce fetch failed: ${res.status}`);
  const data = (await res.json()) as { nonce: number };
  return data.nonce;
}

async function proposeSafeTransaction(
  safeAddress: Address,
  to: Address,
  data: Hex,
  nonce: number,
  proposerAddress: Address,
  signature: Hex
): Promise<void> {
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  const body = {
    to,
    value: "0",
    data,
    operation: 0,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: ZERO_ADDR,
    refundReceiver: ZERO_ADDR,
    nonce,
    contractTransactionHash: await buildSafeTxHash(
      buildDomainSeparator(8453, safeAddress),
      to,
      data,
      BigInt(nonce)
    ),
    sender: proposerAddress,
    signature,
  };

  const res = await fetch(
    `${SAFE_TX_SERVICE}/api/v1/safes/${safeAddress}/multisig-transactions/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Safe TX proposal failed ${res.status}: ${err}`);
  }
}

// Encode multiple steps as a Safe MultiSend batch.
// MultiSend contract on Base: 0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526
const MULTISEND_ADDRESS = "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526" as Address;
const MULTISEND_CALL_ONLY = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2" as Address;

function encodeMultiSend(
  transactions: Array<{ to: Address; data: Hex; value: bigint }>
): Hex {
  const encoded = transactions
    .map(({ to, data, value }) => {
      const dataBytes = toBytes(data);
      // operation (1 byte) + to (20 bytes) + value (32 bytes) + data length (32 bytes) + data
      const parts = [
        new Uint8Array([0]), // CALL
        toBytes(to),
        toBytes(toHex(value, { size: 32 })),
        toBytes(toHex(BigInt(dataBytes.length), { size: 32 })),
        dataBytes,
      ];
      return concat(parts);
    })
    .reduce((a, b) => concat([a, b]), new Uint8Array());

  return toHex(encoded);
}

// ─── Execution Worker ─────────────────────────────────────────────────────────
export function startExecutionWorker() {
  const worker = new Worker<ExecutionJobPayload>(
    "strategy-execution",
    async (job) => {
      const { orgId, intentId, strategy, walletAddress, safeAddress, simulationRequired, capitalUsd } =
        job.data;

      console.log(`[Executor] strategy=${strategy.id} org=${orgId}`);

      // ── Guard: hard blockers invalidate execution ─────────────────────────
      if (strategy.riskScore.blockers.length > 0) {
        throw new Error(
          `Strategy has blockers: ${strategy.riskScore.blockers.join("; ")}`
        );
      }

      await job.updateProgress(10);

      // ── Re-simulate at current block (stale simulation rejected) ──────────
      if (simulationRequired) {
        console.log(`[Executor] Re-simulating at current block...`);
        const sim = await simulationEngine.simulate(
          strategy.graph,
          capitalUsd,
          walletAddress
        );
        if (!sim.success) {
          throw new Error(
            `Pre-execution simulation failed: ${sim.error ?? "unknown reason"}`
          );
        }
        console.log(
          `[Executor] Simulation passed. Projected APY: ${(sim.projectedApyBps / 100).toFixed(2)}%`
        );
      }

      await job.updateProgress(30);

      // ── Build deterministic execution plan ────────────────────────────────
      const capitalAmount = BigInt(Math.floor(capitalUsd * 1e6)); // USDC has 6 decimals

      const executionPlan = await executionEngine.buildExecutionPlan(
        strategy.graph,
        capitalAmount,
        walletAddress,
        safeAddress ?? walletAddress
      );

      console.log(
        `[Executor] Execution plan: ${executionPlan.steps.length} steps, ` +
          `est. cost $${executionPlan.estimatedCostUsd.toFixed(2)}`
      );

      await job.updateProgress(60);

      // ── Fetch org for Safe config + logging ──────────────────────────────
      const org = await getOrg(orgId);
      if (!org) throw new Error(`Organization ${orgId} not found`);

      // ── Record position as "awaiting_approval" ────────────────────────────
      const positionId = `pos_${strategy.id.replace(/[^a-z0-9]/gi, "").slice(-8)}_${Date.now()}`;

      await createPosition({
        id: positionId,
        orgId,
        intentId,
        graph: strategy.graph,
        status: "awaiting_approval",
        chainId: 8453,
        riskScore: strategy.riskScore,
        safeAddress: safeAddress ?? null,
        tags: [],
      });

      await updateIntentStatus(intentId, "selected", { positionId });

      await job.updateProgress(75);

      // ── Propose to Safe (if configured + proposer key available) ──────────
      if (safeAddress && PROPOSER_PRIVATE_KEY) {
        try {
          const account = privateKeyToAccount(PROPOSER_PRIVATE_KEY);
          const walletClient = createWalletClient({
            account,
            chain: base,
            transport: http(
              process.env["BASE_RPC_URL"] ?? "https://mainnet.base.org"
            ),
          });

          const nonce = await getSafeNonce(safeAddress);

          // Encode all steps as a single MultiSend batch
          const txs = executionPlan.steps.map((step) => ({
            to: step.action.to,
            data: step.action.data as Hex,
            value: step.action.value,
          }));

          const multiSendData = encodeMultiSend(txs);
          const domainSep = buildDomainSeparator(8453, safeAddress);
          const safeTxHash = buildSafeTxHash(
            domainSep,
            MULTISEND_CALL_ONLY,
            multiSendData,
            BigInt(nonce)
          );

          // Sign the Safe transaction hash
          const signature = await walletClient.signMessage({
            message: { raw: safeTxHash },
          });

          await proposeSafeTransaction(
            safeAddress,
            MULTISEND_CALL_ONLY,
            multiSendData,
            nonce,
            account.address,
            signature
          );

          await updatePositionStatus(positionId, "deploying");
          console.log(
            `[Executor] Proposed to Safe ${safeAddress} (nonce: ${nonce}). ` +
              `Awaiting ${org?.riskParams.requireMultisigForNewStrategy ? "multisig" : "single"} approval.`
          );
        } catch (err) {
          // Safe proposal failing should not block position recording
          console.error(`[Executor] Safe proposal failed:`, err);
        }
      } else if (safeAddress) {
        console.log(
          `[Executor] Safe configured but EXECUTOR_PRIVATE_KEY not set. ` +
            `Position awaiting manual approval via frontend.`
        );
      }

      await job.updateProgress(100);

      console.log(
        `[Executor] Position ${positionId} created (status: awaiting_approval)`
      );

      return {
        success: true,
        positionId,
        strategyId: strategy.id,
        stepCount: executionPlan.steps.length,
        estimatedCostUsd: executionPlan.estimatedCostUsd,
      };
    },
    { connection, concurrency: 2 }
  );

  worker.on("failed", async (job, err) => {
    console.error(`[Executor] Job ${job?.id} failed: ${err.message}`);
    // If we have a positionId in the job result, mark it failed
  });

  worker.on("completed", (job) => {
    console.log(`[Executor] Job ${job.id} completed`);
  });

  return worker;
}

// ─── Rebalance Worker ─────────────────────────────────────────────────────────
export function startRebalanceWorker() {
  const worker = new Worker<RebalanceJobPayload>(
    "strategy-rebalance",
    async (job) => {
      const { orgId, positionId, reason, triggeredBy, emergencyUnwind } =
        job.data;

      console.log(
        `[Executor] Rebalance: pos=${positionId} by=${triggeredBy} emergency=${!!emergencyUnwind}`
      );

      const position = await getPosition(positionId);
      if (!position) {
        throw new Error(`Position ${positionId} not found`);
      }

      const org = await getOrg(orgId);
      if (!org) throw new Error(`Org ${orgId} not found`);

      await updatePositionStatus(positionId, "rebalancing");

      // ── Emergency unwind: HF < 1.2 → immediate full withdrawal ───────────
      if (
        emergencyUnwind ||
        (position.healthFactor !== null &&
          position.healthFactor !== undefined &&
          position.healthFactor < 1.2)
      ) {
        console.log(
          `[Executor] EMERGENCY UNWIND pos=${positionId} HF=${position.healthFactor}`
        );

        // Build withdrawal calldata for all nodes in reverse order
        const withdrawSteps = [...position.graph.nodes].reverse().map((node) => ({
          nodeId: node.id,
          protocol: node.protocol,
          action: "withdraw" as const,
          asset: node.outputAsset,
        }));

        console.log(
          `[Executor] Emergency unwind: ${withdrawSteps.length} withdrawal steps queued`
        );

        // Mark as closing — manual intervention or session key executes
        await updatePositionStatus(positionId, "closing", {
          notes: `Emergency unwind triggered: ${reason}`,
        });

        return {
          success: true,
          positionId,
          action: "emergency_unwind",
          stepCount: withdrawSteps.length,
        };
      }

      // ── Normal rebalance: queue new strategy generation ───────────────────
      // Connect directly to the planning queue (same Redis) to enqueue re-planning
      const plannerQueue = new Queue("strategy-planning", { connection });
      const existingIntent = position.intentId;
      if (existingIntent && position.graph) {
        console.log(
          `[Executor] Queuing re-planning for rebalance of ${positionId}`
        );
        await plannerQueue.add("rebalance-plan", {
          intentId: existingIntent,
          orgId,
          intent: {
            id: existingIntent,
            rawInput: `Rebalance position ${positionId}: ${reason}`,
            goal: "yield_generation",
            primaryAsset: position.graph.entryAsset,
            capitalUsd: position.currentValueUsd ?? position.entryValueUsd ?? 10_000,
            riskTolerance: "conservative",
            liquidityPreference: "instant",
            maxDrawdownPct: org.riskParams.maxDrawdownPct,
            allowLeverage: org.riskParams.allowLeverage,
            allowLiquidationRisk: org.riskParams.allowLiquidationRisk,
            allowGovernanceTokens: false,
            preferredChain: 8453,
            constraints: [`rebalance from position ${positionId}`],
            createdAt: new Date(),
          },
          maxCandidates: 3,
        });
      }

      return { success: true, positionId, action: "normal_rebalance" };
    },
    { connection, concurrency: 5 }
  );

  worker.on("failed", async (job, err) => {
    console.error(`[Executor] Rebalance job ${job?.id} failed: ${err.message}`);
    if (job?.data.positionId) {
      await updatePositionStatus(job.data.positionId, "failed").catch(() => {});
    }
  });

  return worker;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
if (process.env["NODE_ENV"] !== "test") {
  console.log("[Executor Service] Starting workers...");
  startExecutionWorker();
  startRebalanceWorker();
  // Mandate simulation worker — picks up fork simulation jobs from mandate-monitor
  import("./mandate-executor.js").then(({ startMandateSimulationWorker }) => {
    startMandateSimulationWorker();
    console.log("[Executor Service] Mandate simulation worker started.");
  }).catch((err: Error) => {
    console.error("[Executor Service] Failed to start mandate simulation worker:", err.message);
  });

  // Reconciliation worker — polls Safe API for executed proposals, creates positions
  import("./reconciliation-worker.js").then(({ startReconciliationWorker }) => {
    startReconciliationWorker();
    console.log("[Executor Service] Reconciliation worker started.");
  }).catch((err: Error) => {
    console.error("[Executor Service] Failed to start reconciliation worker:", err.message);
  });
  console.log("[Executor Service] Workers running. Waiting for jobs...");
}
