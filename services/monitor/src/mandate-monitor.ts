// ============================================================
// Mandate Monitor — Autonomous Agent Decision Loop
//
// Runs every 5 minutes via BullMQ repeatable job.
// For each active mandate it:
//   1. Reads live USDC + aUSDC balances from Base RPC
//   2. Computes idleUsd = usdcBalance - reserveFloorUsd
//   3. If idleUsd > IDLE_THRESHOLD → proposes a supply decision
//   4. If usdcBalance < reserveFloorUsd AND aUSDC > 0 → proposes a withdraw
//   5. Writes AgentDecision to DB
//   6. Enqueues a `mandate-simulation` BullMQ job
//   7. Publishes to Redis for WebSocket clients
//
// IMPORTANT: The agent ONLY observes and proposes — it never executes.
// Every proposal flows through MandateSimulator before execution.
// ============================================================

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createPublicClient, http, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import {
  listOrgs,
  getActiveMandateForOrg,
  createAgentDecision,
  mandateHasPendingWork,
} from "@defi-composer/db";
import { getActiveContracts, getActiveChainId, createFallbackTransport } from "@defi-composer/simulation-engine";

// ─── Config ───────────────────────────────────────────────────────────────────

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const REDIS_DECISIONS_CHANNEL = "defi-composer:agent-decisions";

/** Minimum idle USD before the agent proposes a deployment.
 *  Override with IDLE_THRESHOLD_USD env for testnet (Safe may have small balances). */
const IDLE_THRESHOLD_USD = parseFloat(process.env["IDLE_THRESHOLD_USD"] ?? "1000");

/** What fraction of idle capital to propose deploying in a single action.
 *  0.8 = 80% — keeps a small buffer above the floor. */
const IDLE_DEPLOY_FRACTION = 0.8;

// aUSDC addresses per chain (Aave V3 receipt token for USDC)
const AUSDC_BY_CHAIN: Record<number, Address> = {
  8453:  "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB", // Base mainnet
  84532: "0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC", // Base Sepolia
};
function getAUsdcAddress(): Address {
  return AUSDC_BY_CHAIN[getActiveChainId()] ?? AUSDC_BY_CHAIN[8453]!;
}

// ─── ERC-20 ABI (minimal balanceOf) ──────────────────────────────────────────

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function" as const,
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view" as const,
  },
] as const;

// ─── Viem public client ───────────────────────────────────────────────────────
//
// MONITOR_RPC_URL (optional) — override the RPC used for treasury balance reads.
// In fork mode, set this to http://127.0.0.1:18100 so the monitor reads balances
// from the funded Anvil fork rather than mainnet (where test wallets have $0).
//
// Example:
//   MONITOR_RPC_URL=http://127.0.0.1:18100 FORK_MODE=true node services/monitor/dist/index.js

const monitorRpcUrl = process.env["MONITOR_RPC_URL"];
const activeChain = getActiveChainId() === 84532 ? baseSepolia : base;
const publicClient = createPublicClient({
  chain: activeChain,
  transport: monitorRpcUrl
    ? (http(monitorRpcUrl) as ReturnType<typeof createFallbackTransport>)
    : createFallbackTransport(),
});

// ─── Redis clients ────────────────────────────────────────────────────────────

const redisPub = new Redis(REDIS_URL);

function redisConnection() {
  const url = new URL(REDIS_URL);
  return {
    host: url.hostname,
    port: parseInt(url.port || "6379", 10),
  };
}

// ─── BullMQ queues ────────────────────────────────────────────────────────────

/** The queue this monitor writes to. MandateSimulator is the consumer. */
const simulationQueue = new Queue("mandate-simulation", {
  connection: redisConnection(),
});

/** Self-scheduling queue — this monitor adds a repeatable job to it. */
const mandateScanQueue = new Queue("mandate-scan", {
  connection: redisConnection(),
});

// ─── On-chain balance helpers ─────────────────────────────────────────────────

async function readUsdcBalance(wallet: Address): Promise<number> {
  const raw = await publicClient.readContract({
    address: getActiveContracts().USDC,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [wallet],
  });
  return Number(raw) / 1e6; // USDC = 6 decimals
}

async function readAUsdcBalance(wallet: Address): Promise<number> {
  const raw = await publicClient.readContract({
    address: getAUsdcAddress(),
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [wallet],
  });
  return Number(raw) / 1e6; // aUSDC mirrors USDC decimals
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface MandateVersion {
  id: string;
  reserveFloorUsd: number;
  maxSingleActionUsd: number | null;
  approvedProtocols: string[];
  approvedActions: string[];
}

interface ActiveMandate {
  id: string;
  orgId: string;
  versions: MandateVersion[];
  activeVersionId: string | null;
}

interface ObservedState {
  walletAddress: string;
  usdcBalanceUsd: number;
  aUsdcBalanceUsd: number;
  idleUsd: number;
  reserveFloorUsd: number;
  reserveBreached: boolean;
  checkedAt: string;
}

// ─── Core scan logic ──────────────────────────────────────────────────────────

/**
 * Scans all active mandates for a single org and creates agent decisions
 * for any idle capital or reserve breaches it finds.
 */
async function scanOrgMandates(orgId: string): Promise<void> {
  const mandate = await getActiveMandateForOrg(orgId) as ActiveMandate | undefined;
  if (!mandate) {
    console.log(`[MandateMonitor] org=${orgId}: no active mandate, skipping`);
    return;
  }

  // Resolve the active mandate version
  const activeVersion = mandate.activeVersionId
    ? mandate.versions.find((v) => v.id === mandate.activeVersionId)
    : mandate.versions[0];

  if (!activeVersion) {
    console.warn(`[MandateMonitor] org=${orgId} mandate=${mandate.id}: no version found`);
    return;
  }

  // Fetch the org wallets — we need a treasury wallet address on Base
  const orgs = await listOrgs();
  const org = orgs.find((o) => o.id === orgId);
  if (!org) return;

  const activeChainId = getActiveChainId();
  const baseWallets = org.wallets.filter((w) => w.chainId === activeChainId);
  if (baseWallets.length === 0) {
    console.log(`[MandateMonitor] org=${orgId}: no wallets on chain ${activeChainId}`);
    return;
  }

  // Use the first treasury wallet (or the Safe address if present)
  const treasuryAddress = (org.safeAddress ?? baseWallets[0]!.address) as Address;

  // Read live balances
  let usdcBalanceUsd: number;
  let aUsdcBalanceUsd: number;

  try {
    [usdcBalanceUsd, aUsdcBalanceUsd] = await Promise.all([
      readUsdcBalance(treasuryAddress),
      readAUsdcBalance(treasuryAddress),
    ]);
  } catch (err) {
    console.error(
      `[MandateMonitor] org=${orgId}: RPC read failed —`,
      (err as Error).message
    );
    return;
  }

  const reserveFloorUsd = activeVersion.reserveFloorUsd;
  const idleUsd = usdcBalanceUsd - reserveFloorUsd;
  const reserveBreached = usdcBalanceUsd < reserveFloorUsd && aUsdcBalanceUsd > 0;

  const observedState: ObservedState = {
    walletAddress: treasuryAddress,
    usdcBalanceUsd,
    aUsdcBalanceUsd,
    idleUsd,
    reserveFloorUsd,
    reserveBreached,
    checkedAt: new Date().toISOString(),
  };

  console.log(
    `[MandateMonitor] org=${orgId} wallet=${treasuryAddress} ` +
      `USDC=$${usdcBalanceUsd.toFixed(2)} aUSDC=$${aUsdcBalanceUsd.toFixed(2)} ` +
      `idle=$${idleUsd.toFixed(2)} reserveBreached=${reserveBreached}`
  );

  // ── Idempotency guard ──────────────────────────────────────────────────
  // Don't create new decisions while the last one is still in-flight.
  // In fork mode the on-chain state never changes, so without this guard
  // the monitor would queue a new decision every 5 minutes forever.
  const hasPending = await mandateHasPendingWork(mandate.id);
  if (hasPending) {
    console.log(
      `[MandateMonitor] org=${orgId} mandate=${mandate.id}: ` +
      `pending work in-flight — skipping scan`
    );
    return;
  }

  // ── Case 1: idle capital detected ────────────────────────────────────────
  if (idleUsd > IDLE_THRESHOLD_USD) {
    const deployAmount = Math.min(
      idleUsd * IDLE_DEPLOY_FRACTION,
      activeVersion.maxSingleActionUsd ?? idleUsd * IDLE_DEPLOY_FRACTION
    );

    await createAndEnqueueDecision({
      orgId,
      mandate: mandate as ActiveMandate,
      activeVersion,
      trigger: "idle_capital_detected",
      observedState,
      selectedPlaybook: "aave_supply_usdc",
      playbookParams: {
        amountHuman: deployAmount.toFixed(6),
        onBehalfOf: treasuryAddress,
      },
      explanation:
        `Detected $${idleUsd.toFixed(2)} idle above reserve floor ` +
        `($${reserveFloorUsd.toFixed(2)}). ` +
        `Proposing to supply $${deployAmount.toFixed(2)} USDC to Aave V3 ` +
        `(${(IDLE_DEPLOY_FRACTION * 100).toFixed(0)}% of idle, ` +
        `capped at maxSingleActionUsd).`,
    });
  }

  // ── Case 2: reserve floor breached ───────────────────────────────────────
  if (reserveBreached) {
    const withdrawAmount = reserveFloorUsd - usdcBalanceUsd;

    await createAndEnqueueDecision({
      orgId,
      mandate: mandate as ActiveMandate,
      activeVersion,
      trigger: "reserve_floor_breach",
      observedState,
      selectedPlaybook: "aave_withdraw_usdc",
      playbookParams: {
        amountHuman: withdrawAmount.toFixed(6),
        recipient: treasuryAddress,
      },
      explanation:
        `Reserve floor breached: USDC balance $${usdcBalanceUsd.toFixed(2)} ` +
        `is below floor $${reserveFloorUsd.toFixed(2)}. ` +
        `Proposing to withdraw $${withdrawAmount.toFixed(2)} USDC from Aave V3 ` +
        `to restore reserve.`,
    });
  }
}

// ─── Decision creation + enqueueing ──────────────────────────────────────────

interface DecisionInput {
  orgId: string;
  mandate: ActiveMandate;
  activeVersion: MandateVersion;
  trigger: string;
  observedState: ObservedState;
  selectedPlaybook: string;
  playbookParams: Record<string, unknown>;
  explanation: string;
}

async function createAndEnqueueDecision(input: DecisionInput): Promise<void> {
  const {
    orgId,
    mandate,
    activeVersion,
    trigger,
    observedState,
    selectedPlaybook,
    playbookParams,
    explanation,
  } = input;

  const decisionId = `decision_${randomUUID()}`;
  const now = new Date();

  // 1. Persist AgentDecision row
  let decision: Awaited<ReturnType<typeof createAgentDecision>>;
  try {
    decision = await createAgentDecision({
      id: decisionId,
      orgId,
      mandateId: mandate.id,
      mandateVersionId: activeVersion.id,
      strategyCellId: null,
      trigger,
      observedState: observedState as unknown as Record<string, unknown>,
      selectedPlaybook,
      playbookParams,
      rejectedAlternatives: [],
      explanation,
      status: "proposed",
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    console.error(
      `[MandateMonitor] Failed to persist decision for org=${orgId}:`,
      (err as Error).message
    );
    return;
  }

  console.log(
    `[MandateMonitor] Decision created: id=${decision.id} ` +
      `trigger=${trigger} playbook=${selectedPlaybook} org=${orgId}`
  );

  // 2. Enqueue mandate-simulation job
  // Payload must match MandateSimulationJobPayload in mandate-executor.ts
  try {
    await simulationQueue.add(
      "simulate-decision",
      {
        orgId,
        mandateId: mandate.id,
        playbook: selectedPlaybook,
        amountHuman: String(playbookParams["amountHuman"] ?? "1000"),
        // Pass Safe/treasury address so calldata has correct onBehalfOf/to
        onBehalfOf: String(playbookParams["onBehalfOf"] ?? playbookParams["recipient"] ?? ""),
        trigger,
        explanation,
        observedLiquidUsd: observedState.usdcBalanceUsd,
        existingDecisionId: decision.id,   // executor must NOT create a new decision
      },
      {
        jobId: `sim-${decision.id}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
      }
    );

    console.log(
      `[MandateMonitor] Enqueued mandate-simulation job for decision=${decision.id}`
    );
  } catch (err) {
    console.error(
      `[MandateMonitor] Failed to enqueue simulation job for decision=${decision.id}:`,
      (err as Error).message
    );
  }

  // 3. Publish to Redis for WebSocket clients (non-blocking)
  redisPub
    .publish(
      REDIS_DECISIONS_CHANNEL,
      JSON.stringify({
        event: "agent_decision",
        orgId,
        decision: {
          id: decision.id,
          trigger,
          selectedPlaybook,
          explanation,
          status: "proposed",
          observedState,
          createdAt: now.toISOString(),
        },
      })
    )
    .catch((err: unknown) =>
      console.error("[MandateMonitor] Redis publish failed:", err)
    );
}

// ─── Scan all orgs ────────────────────────────────────────────────────────────

async function scanAllOrgs(): Promise<void> {
  console.log("[MandateMonitor] Starting mandate scan for all orgs...");
  const orgs = await listOrgs();

  if (orgs.length === 0) {
    console.log("[MandateMonitor] No orgs found, scan complete.");
    return;
  }

  const results = await Promise.allSettled(
    orgs.map((org) => scanOrgMandates(org.id))
  );

  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    console.error(
      `[MandateMonitor] ${failed.length}/${orgs.length} org scans failed`
    );
  }

  console.log(
    `[MandateMonitor] Scan complete: ${orgs.length} orgs checked, ` +
      `${failed.length} errors`
  );
}

// ─── BullMQ worker ────────────────────────────────────────────────────────────

let mandateScanWorker: Worker | null = null;

async function startMandateMonitor(): Promise<void> {
  // Register a repeatable scan job (every 5 minutes)
  await mandateScanQueue.add(
    "scan-all-mandates",
    {},
    {
      repeat: { every: 5 * 60 * 1000 }, // 5 min
      jobId: "mandate-scan-repeating",
    }
  );

  console.log(
    "[MandateMonitor] Scheduled repeating scan every 5 minutes via BullMQ"
  );

  // Worker that processes the scan jobs
  mandateScanWorker = new Worker(
    "mandate-scan",
    async (_job: Job) => {
      await scanAllOrgs();
    },
    {
      connection: redisConnection(),
      concurrency: 1, // single-threaded scan to avoid duplicate decisions
    }
  );

  mandateScanWorker.on("failed", (job, err) => {
    console.error(
      `[MandateMonitor] Scan job ${job?.id ?? "?"} failed:`,
      err.message
    );
  });

  mandateScanWorker.on("completed", (job) => {
    console.log(`[MandateMonitor] Scan job ${job.id} completed`);
  });

  console.log("[MandateMonitor] Worker started and listening for scan jobs");

  // Run an immediate scan on startup (without waiting for the first interval)
  scanAllOrgs().catch((err) =>
    console.error("[MandateMonitor] Initial scan failed:", err)
  );
}

async function stopMandateMonitor(): Promise<void> {
  if (mandateScanWorker) {
    await mandateScanWorker.close();
    mandateScanWorker = null;
  }
  await simulationQueue.close();
  await mandateScanQueue.close();
  await redisPub.quit();
  console.log("[MandateMonitor] Stopped.");
}

// ─── Public API ───────────────────────────────────────────────────────────────

export {
  startMandateMonitor,
  stopMandateMonitor,
  scanOrgMandates,
  scanAllOrgs,
};
