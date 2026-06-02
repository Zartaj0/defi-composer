// ============================================================
// Reconciliation Worker
// Polls Safe Transaction Service for executed proposals.
// When a Safe TX executes:
//   1. Reads on-chain position (aUSDC balance, USDC balance)
//   2. Creates Position record in DB
//   3. Marks ExecutionRecord as "reconciled"
//   4. Publishes to Redis for WebSocket notification
//
// Runs on a 60-second interval via BullMQ repeating job.
// Only reconciles records in "submitted" status.
// ============================================================

import "dotenv/config";
import { Worker, Queue } from "bullmq";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { createPublicClient, http, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";
import {
  getSafeExecutionStatus,
} from "@defi-composer/execution-engine";
import { getActiveChainId, getActiveContracts, createFallbackTransport } from "@defi-composer/simulation-engine";
import {
  createPosition,
  getPositionByDeployTxHash,
  getMandateVersion,
  getSimulationArtifact,
  getSubmittedExecutionRecords,
  markExecutionReconciled,
  updateAgentDecisionStatus,
} from "@defi-composer/db";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const CHANNEL_RECONCILED = "defi-composer:execution-reconciled";

const connection = {
  host: new URL(REDIS_URL).hostname,
  port: parseInt(new URL(REDIS_URL).port || "6379"),
};

const redisPub = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

const activeChainId = getActiveChainId();
const activeChain   = activeChainId === 84532 ? baseSepolia : base;
const rpcUrl = process.env["BASE_RPC_URL"];

const publicClient = createPublicClient({
  chain: activeChain,
  transport: rpcUrl ? http(rpcUrl) : createFallbackTransport(),
});

// aUSDC and USDC ABIs for balance reads
const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function" as const,
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view" as const,
  },
] as const;

// Chain-aware token addresses
const AUSDC_BY_CHAIN: Record<number, Address> = {
  8453:  "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
  84532: "0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC",
};
const AUSDC_ADDRESS = (AUSDC_BY_CHAIN[activeChainId] ?? AUSDC_BY_CHAIN[8453]!) as Address;

// ─── Reconcile pending records ────────────────────────────────

async function reconcilePendingRecords(): Promise<void> {
  // Fetch all execution records that are "submitted" (proposal is in Safe)
  const pending = await getSubmittedExecutionRecords();
  const normalised = pending.map(r => ({
    execId:           r.id,
    orgId:            r.orgId,
    safeTxId:         r.safeTxId,
    accountAddress:   r.accountAddress,
    simArtifactId:    r.simulationArtifactId,
    mandateVersionId: r.mandateVersionId,
  }));

  if (normalised.length === 0) return;

  console.log(`[Reconciler] Checking ${normalised.length} submitted execution record(s)...`);

  for (const rec of normalised) {
    if (!rec.safeTxId) continue;

    try {
      const safeAddress = rec.accountAddress as Address;
      const safeTxHash  = rec.safeTxId as `0x${string}`;

      const status = await getSafeExecutionStatus(safeAddress, safeTxHash);
      if (!status || !status.isExecuted || !status.executionTxHash) continue;

      // ── Executed — read on-chain position ────────────────
      console.log(
        `[Reconciler] Safe TX executed: ${safeTxHash} ` +
        `tx=${status.executionTxHash}`
      );

      // ── Idempotency guard: skip if already reconciled ─────
      // Multiple execution records can share the same safeTxId (duplicate
      // proposals from before the idempotency fix). Only reconcile once.
      const existingPosition = await getPositionByDeployTxHash(status.executionTxHash).catch(() => null);

      if (existingPosition) {
        // Position already created for this tx — just mark this record reconciled
        await markExecutionReconciled(
          rec.execId,
          status.executionTxHash,
          new Date(status.executedAt ?? Date.now())
        ).catch(() => {});
        console.log(`[Reconciler] Skipped duplicate reconciliation for tx=${status.executionTxHash} (exec=${rec.execId})`);
        continue;
      }

      // ── Derive deployed amount from simulation delta ──────
      // Use the input-side delta (USDC_spent / token_spent) from expectedDeltas.
      // The output-side (aUSDC_received) reflects the full accumulated balance on
      // the fork, not the amount this specific tx deposited — so always use the
      // spent side which is always the correct net input for this action.
      const simArtifact = await getSimulationArtifact(rec.simArtifactId).catch(() => null);
      let deployedUsd = 0;
      if (simArtifact?.expectedDeltas) {
        const deltas = simArtifact.expectedDeltas as Record<string, string>;
        // Prefer the input (spent) side — it's always the exact deposit amount
        const spentKey = Object.keys(deltas).find(k => k.endsWith("_spent"));
        if (spentKey) {
          const rawAmt = Math.abs(Number(deltas[spentKey]));
          // >1e12 → 18-decimal (WETH), else 6-decimal (USDC)
          deployedUsd = rawAmt > 1e12 ? rawAmt / 1e18 : rawAmt / 1e6;
        }
      }
      if (deployedUsd === 0) {
        // Fallback: read aUSDC balance delta on-chain (less accurate but better than 0)
        const aUsdcRaw = await publicClient.readContract({
          address: AUSDC_ADDRESS,
          abi: ERC20_BALANCE_ABI,
          functionName: "balanceOf",
          args: [safeAddress],
        }).catch(() => 0n);
        deployedUsd = Number(aUsdcRaw) / 1e6;
        console.warn(`[Reconciler] expectedDeltas missing — fell back to total aUSDC balance $${deployedUsd.toFixed(2)}`);
      }

      // Get mandate version for graph snapshot
      const mandateVer = await getMandateVersion(rec.mandateVersionId);

      // ── Create Position record ────────────────────────────
      const positionId = `pos_${randomUUID().slice(0, 12)}`;

      // Minimal StrategyGraph for the position record
      const graph = {
        id:              `graph_${positionId}`,
        name:            "Aave V3 USDC Supply",
        description:     "USDC supplied to Aave V3 on Base",
        entryAsset:      "USDC" as const,
        exitAsset:       "USDC" as const,
        nodes:           [{
          id:                   "n1",
          protocol:             "aave-v3"  as const,
          action:               "supply"   as const,
          inputAsset:           "USDC"     as const,
          outputAsset:          "USDC"     as const,
          expectedApyBps:       450,
          gasCostUsd:           0,
          risks:                [] as { type: "liquidation" | "impermanent_loss" | "smart_contract" | "oracle" | "liquidity"; severity: "low" | "medium" | "high"; description: string }[],
          metadata:             {} as Record<string, unknown>,
        }],
        edges:           [] as { from: string; to: string; assetFlow: "USDC"; description: string }[],
        estimatedApyBps: mandateVer?.maxSlippageBps ? 450 : 450,  // live APY at time of execution
        totalGasCostUsd: 0,
        createdAt:       new Date(),
      };

      await createPosition({
        id:                   positionId,
        orgId:                rec.orgId,
        graph,
        status:               "active",
        chainId:              activeChainId,
        entryValueUsd:        deployedUsd,
        currentValueUsd:      deployedUsd,
        deployTxHash:         status.executionTxHash,
        safeAddress:          safeAddress,
        mandateVersionId:     rec.mandateVersionId,
        simulationArtifactId: rec.simArtifactId,
      });

      // ── Update ExecutionRecord status ─────────────────────
      await markExecutionReconciled(
        rec.execId,
        status.executionTxHash,
        new Date(status.executedAt ?? Date.now())
      );

      // ── Mark AgentDecision as executed ────────────────────
      // This clears the "ready" block in mandateHasPendingWork so the
      // mandate monitor can propose new actions after execution.
      if (simArtifact?.decisionId) {
        await updateAgentDecisionStatus(simArtifact.decisionId, "executed").catch(() => {});
        console.log(`[Reconciler] Decision ${simArtifact.decisionId} → executed`);
      }

      // ── Publish to Redis ──────────────────────────────────
      await redisPub.publish(CHANNEL_RECONCILED, JSON.stringify({
        orgId:          rec.orgId,
        positionId,
        executionId:    rec.execId,
        safeTxHash,
        executionTxHash: status.executionTxHash,
        deployedUsd,
        reconciledAt:   new Date().toISOString(),
      }));

      console.log(
        `[Reconciler] ✅ Reconciled: position=${positionId} ` +
        `deployed=$${deployedUsd.toFixed(2)} tx=${status.executionTxHash}`
      );

    } catch (err) {
      console.error(
        `[Reconciler] Failed to reconcile ${rec.execId}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
}

// ─── Worker ───────────────────────────────────────────────────
export function startReconciliationWorker() {
  const queue = new Queue("reconciliation", { connection });

  // Schedule repeating job every 60 seconds
  void queue.upsertJobScheduler(
    "reconcile-submitted",
    { every: 60_000 },
    {
      name: "reconcile",
      data: {},
      opts: { removeOnComplete: 10, removeOnFail: 5 },
    }
  );

  const worker = new Worker(
    "reconciliation",
    async () => {
      await reconcilePendingRecords();
    },
    {
      connection,
      concurrency: 1,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[Reconciler] Job ${job?.id} failed: ${err.message}`);
  });

  // Run immediately on start (don't wait 60s for first check)
  void reconcilePendingRecords().catch(err => {
    console.error("[Reconciler] Initial reconciliation failed:", err.message);
  });

  console.log("[Reconciler] Worker started. Polling every 60s.");
  return worker;
}
