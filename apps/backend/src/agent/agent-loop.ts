// ============================================================
// Agent Loop — Redis-free autonomous treasury management
//
// Replaces BullMQ workers (mandate-monitor + mandate-executor)
// with plain setInterval loops that run inside the backend process.
//
// Scan every 5 min:
//   Read live balances → detect idle capital / reserve breach
//   → create AgentDecision → run fork simulation inline
//   → create SimulationArtifact + ExecutionRecord + Position
//   → submit Safe proposal OR execute via PolicyModule
//
// Reconcile every 60 sec:
//   Check submitted Safe TX → mark reconciled when executed on-chain
// ============================================================

import { randomUUID } from "node:crypto";
import { createPublicClient, http, type Address } from "viem";
import { base, baseSepolia, mainnet } from "viem/chains";
import {
  listOrgs,
  getActiveMandateForOrg,
  createAgentDecision,
  mandateHasPendingWork,
  createSimulationArtifact,
  createExecutionRecord,
  createPosition,
  updateAgentDecisionStatus,
  getSubmittedExecutionRecords,
  markExecutionReconciled,
  getSimulationArtifact,
  getMandateVersion,
  getPositionByDeployTxHash,
} from "@defi-composer/db";
import {
  mandateSimulator,
  type PlaybookName,
  type MandatePolicy,
  getActiveContracts,
  getActiveChainId,
  createFallbackTransport,
} from "@defi-composer/simulation-engine";
import {
  submitSafeProposal,
  getSafeInfo,
  isPolicyModuleEnabled,
  executePolicyModule,
  getSafeExecutionStatus,
} from "@defi-composer/execution-engine";
import { buildSafeTxStruct } from "@defi-composer/simulation-engine";

// ─── Config ───────────────────────────────────────────────────

const SCAN_INTERVAL_MS = parseInt(process.env["SCAN_INTERVAL_MS"] ?? "300000"); // 5 min
const RECONCILE_INTERVAL_MS = parseInt(process.env["RECONCILE_INTERVAL_MS"] ?? "60000"); // 60 sec
const IDLE_THRESHOLD_USD = parseFloat(process.env["IDLE_THRESHOLD_USD"] ?? "100");
const IDLE_DEPLOY_FRACTION = 0.8;
const MAX_CONCURRENT_SIMS = 2; // max parallel Anvil forks

// ─── Chain-aware addresses ────────────────────────────────────

const AUSDC_BY_CHAIN: Record<number, Address> = {
  8453:  "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",  // aUSDC Base mainnet (Aave V3)
  84532: "0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC",  // aUSDC Base Sepolia (Aave V3)
  52638: "0x98C23E9d8f34FEFb1B7BD6a91B7AF122a1f5cE47",  // aUSDC Ethereum mainnet = contract.dev stagenet
  1:     "0x98C23E9d8f34FEFb1B7BD6a91B7AF122a1f5cE47",  // aUSDC Ethereum mainnet
};

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function" as const,
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view" as const,
  },
] as const;

// ─── Viem client ──────────────────────────────────────────────

const activeChainId = getActiveChainId();
// contract.dev stagenet (52638) is a fork of Ethereum mainnet — use `mainnet` chain type
// so viem uses EIP-155 Ethereum transaction format (not OP-stack).
const activeChain =
  activeChainId === 84532 ? baseSepolia :
  activeChainId === 52638 ? mainnet :     // contract.dev stagenet = Ethereum mainnet fork
  activeChainId === 1    ? mainnet :
  base;
const monitorRpcUrl = process.env["MONITOR_RPC_URL"] ?? process.env["BASE_RPC_URL"];
const publicClient = createPublicClient({
  chain: activeChain,
  transport: monitorRpcUrl ? http(monitorRpcUrl, { timeout: 8_000 }) : createFallbackTransport(),
});

function getAUsdcAddress(): Address {
  return (AUSDC_BY_CHAIN[activeChainId] ?? AUSDC_BY_CHAIN[8453]!) as Address;
}

function isForkMode(): boolean {
  const v = process.env["FORK_MODE"];
  return v !== "false" && v !== "0";
}

// ─── Balance reads ────────────────────────────────────────────

async function readUsdcBalance(wallet: Address): Promise<number> {
  const raw = await publicClient.readContract({
    address: getActiveContracts().USDC,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [wallet],
  });
  return Number(raw) / 1e6;
}

async function readAUsdcBalance(wallet: Address): Promise<number> {
  const raw = await publicClient.readContract({
    address: getAUsdcAddress(),
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [wallet],
  });
  return Number(raw) / 1e6;
}

// ─── Simple job queue (no Redis) ─────────────────────────────

interface SimJob {
  orgId: string;
  mandateId: string;
  mandateVersionId: string;
  playbook: PlaybookName;
  amountHuman: string;
  onBehalfOf: string;
  trigger: string;
  explanation: string;
  observedLiquidUsd: number;
  decisionId: string;
  reserveFloorUsd: number;
  approvedAssets: string[];
  approvedProtocols: string[];
  approvedActions: string[];
  blockedActions: string[];
  maxSlippageBps: number;
  maxSingleActionUsd: number | null;
  safeAddress: string | null;
}

const simQueue: SimJob[] = [];
let runningSims = 0;

function drainSimQueue() {
  while (simQueue.length > 0 && runningSims < MAX_CONCURRENT_SIMS) {
    const job = simQueue.shift()!;
    runningSims++;
    void runSimulation(job).finally(() => {
      runningSims--;
      drainSimQueue();
    });
  }
}

// ─── Core simulation + execution ──────────────────────────────

async function runSimulation(job: SimJob): Promise<void> {
  const {
    orgId, mandateId, mandateVersionId, playbook, amountHuman,
    onBehalfOf, trigger, explanation, observedLiquidUsd,
    decisionId, safeAddress, reserveFloorUsd, approvedAssets,
    approvedProtocols, approvedActions, blockedActions,
    maxSlippageBps, maxSingleActionUsd,
  } = job;

  console.log(`[Agent] Running simulation: decision=${decisionId} playbook=${playbook} amount=${amountHuman}`);

  const policy: MandatePolicy = {
    mandateVersionId,
    approvedAssets,
    approvedProtocols,
    approvedActions,
    blockedActions,
    maxSlippageBps,
    ...(maxSingleActionUsd != null ? { maxSingleActionUsd } : {}),
    reserveFloorUsd,
  };

  // ── Run fork simulation ────────────────────────────────────
  let artifact;
  const simId = `sim_${randomUUID().slice(0, 12)}`;

  try {
    artifact = await mandateSimulator.run({
      playbook,
      mandate: policy,
      params: {
        amountHuman,
        ...(onBehalfOf ? { onBehalfOf: onBehalfOf as `0x${string}` } : {}),
      },
      observedState: { liquidUsd: observedLiquidUsd },
      decisionId,
      orgId,
    });
  } catch (err) {
    const rpcSource = process.env["BASE_RPC_URL"] ?? "https://mainnet.base.org";
    artifact = {
      id: simId,
      orgId,
      decisionId,
      mandateVersionId,
      chainId: activeChainId,
      forkBlockNumber: 0,
      validUntilBlock: 0,
      rpcSource,
      calldataHash: "0x",
      inputCalldata: [],
      balancesBefore: {},
      balancesAfter: {},
      expectedDeltas: {},
      gasEstimate: 0,
      status: "failed" as const,
      failureReason: err instanceof Error ? err.message : String(err),
      executionMode: "fork" as const,
      createdAt: new Date(),
    };
  }

  // ── Persist simulation artifact ────────────────────────────
  const simulationId = artifact.id ?? simId;
  try {
    await createSimulationArtifact({
      id: simulationId,
      orgId,
      decisionId,
      mandateVersionId,
      chainId: artifact.chainId,
      forkBlockNumber: artifact.forkBlockNumber,
      validUntilBlock: artifact.validUntilBlock,
      rpcSource: artifact.rpcSource,
      calldataHash: artifact.calldataHash,
      inputCalldata: artifact.inputCalldata,
      balancesBefore: artifact.balancesBefore,
      balancesAfter: artifact.balancesAfter,
      expectedDeltas: artifact.expectedDeltas,
      gasEstimate: artifact.gasEstimate,
      status: artifact.status,
      ...(artifact.failureReason ? { failureReason: artifact.failureReason } : {}),
    });
  } catch (dbErr) {
    console.error(`[Agent] Failed to persist simulation artifact: ${(dbErr as Error).message}`);
    return;
  }

  if (artifact.status !== "passed") {
    await updateAgentDecisionStatus(decisionId, "blocked").catch(() => {});
    console.log(`[Agent] Simulation ${artifact.status}: ${artifact.failureReason ?? "unknown"}`);
    return;
  }

  // ── Simulation passed — create execution record ────────────
  const execId = `exec_${randomUUID().slice(0, 12)}`;

  if (isForkMode()) {
    // Fork mode: create position as fork_simulation proof
    await createExecutionRecord({
      id: execId,
      orgId,
      simulationArtifactId: simulationId,
      mandateVersionId,
      accountAddress: safeAddress ?? `0x${"0".repeat(40)}`,
      status: "proposed",
    });

    // Derive deployed amount from delta
    const deltas = artifact.expectedDeltas as Record<string, string>;
    const spentKey = Object.keys(deltas).find(k => k.endsWith("_spent"));
    const rawAmt = spentKey ? Math.abs(Number(deltas[spentKey])) : 0;
    const deployedUsd = rawAmt > 1e12 ? rawAmt / 1e18 : rawAmt > 0 ? rawAmt / 1e6 : parseFloat(amountHuman);
    const positionId = `pos_${randomUUID().slice(0, 12)}`;

    await createPosition({
      id: positionId,
      orgId,
      graph: {
        id: `graph_${positionId}`,
        name: `${playbook.replace(/_/g, " ")} (fork proven)`,
        description: `Fork-simulated ${playbook} at block ${artifact.forkBlockNumber}`,
        entryAsset: "USDC",
        exitAsset: "USDC",
        nodes: [{
          id: "n1",
          protocol: playbook.includes("morpho") ? "morpho-blue" : "aave-v3",
          action: playbook.includes("withdraw") ? "withdraw" : "supply",
          inputAsset: "USDC",
          outputAsset: "USDC",
          expectedApyBps: 450,
          gasCostUsd: artifact.gasEstimate * 3e-9,
          risks: [],
          metadata: { forkBlock: artifact.forkBlockNumber },
        }],
        edges: [],
        estimatedApyBps: 450,
        totalGasCostUsd: artifact.gasEstimate * 3e-9,
        createdAt: new Date(),
      },
      status: "active",
      chainId: activeChainId,
      entryValueUsd: deployedUsd,
      currentValueUsd: deployedUsd,
      deployTxHash: `sim:${simulationId}`,
      safeAddress: safeAddress ?? null,
      mandateVersionId,
      simulationArtifactId: simulationId,
      tags: ["fork_simulation"],
      notes: `Fork-proven at block ${artifact.forkBlockNumber}. Gas: ${artifact.gasEstimate.toLocaleString()}`,
    });

    await updateAgentDecisionStatus(decisionId, "ready").catch(() => {});
    console.log(
      `[Agent] ✅ Fork proof created: decision=${decisionId} sim=${simulationId} ` +
      `pos=${positionId} value=$${deployedUsd.toFixed(2)}`
    );
    return;
  }

  // ── Production mode — PolicyModule or Safe proposal ────────
  const calldata = artifact.inputCalldata as Array<{ to: string; data: string; value?: string }>;
  const safeTxStruct = buildSafeTxStruct(calldata, artifact.gasEstimate);
  const prodDeltas = artifact.expectedDeltas as Record<string, string>;
  const prodSpentKey = Object.keys(prodDeltas).find(k => k.endsWith("_spent"));
  const prodRawAmt = prodSpentKey ? Math.abs(Number(prodDeltas[prodSpentKey])) : 0;
  const declaredUsdcAmount = prodRawAmt > 1e12
    ? Math.round((prodRawAmt / 1e18) * 1e6)
    : prodRawAmt > 0 ? prodRawAmt
    : Math.round(parseFloat(amountHuman) * 1e6);

  const policyModuleEnabled = await isPolicyModuleEnabled().catch(() => false);
  let usedPolicyModule = false;

  if (policyModuleEnabled && safeAddress && process.env["EXECUTOR_PRIVATE_KEY"]) {
    try {
      const result = await executePolicyModule({ safeTxStruct, simulationId, declaredUsdcAmount });
      await createExecutionRecord({
        id: execId,
        orgId,
        simulationArtifactId: simulationId,
        mandateVersionId,
        accountAddress: safeAddress,
        status: "reconciled",
        transactionHash: result.txHash,
        submittedAt: new Date(result.executedAt),
        executedAt: new Date(result.executedAt),
        reconciledAt: new Date(),
      });
      await updateAgentDecisionStatus(decisionId, "executed").catch(() => {});
      usedPolicyModule = true;
      console.log(`[Agent] ✅ PolicyModule executed: txHash=${result.txHash}`);
    } catch (err) {
      console.warn(`[Agent] PolicyModule failed, falling back to Safe proposal: ${(err as Error).message}`);
    }
  }

  if (!usedPolicyModule) {
    let safeTxId: string | null = null;
    let execStatus: "proposed" | "submitted" = "proposed";

    if (safeAddress && process.env["EXECUTOR_PRIVATE_KEY"]) {
      try {
        const safeInfo = await getSafeInfo(safeAddress as `0x${string}`);
        if (safeInfo) {
          const result = await submitSafeProposal({
            safeAddress: safeAddress as `0x${string}`,
            safeTxStruct,
            simulationId,
          });
          safeTxId = result.safeTxHash;
          execStatus = "submitted";
          console.log(`[Agent] 🔐 Safe proposal submitted: ${safeTxId}`);
        }
      } catch (err) {
        console.warn(`[Agent] Safe proposal failed: ${(err as Error).message}`);
      }
    }

    await createExecutionRecord({
      id: execId,
      orgId,
      simulationArtifactId: simulationId,
      mandateVersionId,
      accountAddress: safeAddress ?? `0x${"0".repeat(40)}`,
      status: execStatus,
      ...(safeTxId ? { safeTxId } : {}),
      ...(execStatus === "submitted" ? { submittedAt: new Date() } : {}),
    });

    await updateAgentDecisionStatus(decisionId, "ready").catch(() => {});
    console.log(`[Agent] ✅ Execution record created: ${execId} status=${execStatus}`);
  }
}

// ─── Scan single org ──────────────────────────────────────────

async function scanOrg(orgId: string, safeAddress: string | null, walletAddress: string): Promise<void> {
  const mandate = await getActiveMandateForOrg(orgId);
  if (!mandate) return;

  const activeVersion = mandate.activeVersionId
    ? mandate.versions.find(v => v.id === mandate.activeVersionId)
    : mandate.versions[0];

  if (!activeVersion) return;

  const treasuryAddress = (safeAddress ?? walletAddress) as Address;

  let usdcBalance: number;
  let aUsdcBalance: number;

  try {
    [usdcBalance, aUsdcBalance] = await Promise.all([
      readUsdcBalance(treasuryAddress),
      readAUsdcBalance(treasuryAddress),
    ]);
  } catch (err) {
    console.error(`[Agent] Balance read failed for org=${orgId}: ${(err as Error).message}`);
    return;
  }

  const reserveFloor = activeVersion.reserveFloorUsd as number;
  const idleUsd = usdcBalance - reserveFloor;
  const reserveBreached = usdcBalance < reserveFloor && aUsdcBalance > 0;

  console.log(
    `[Agent] org=${orgId} USDC=$${usdcBalance.toFixed(2)} ` +
    `aUSDC=$${aUsdcBalance.toFixed(2)} idle=$${idleUsd.toFixed(2)}`
  );

  // Idempotency — don't queue if work is already in-flight
  const hasPending = await mandateHasPendingWork(mandate.id);
  if (hasPending) {
    console.log(`[Agent] org=${orgId}: pending work in-flight, skipping`);
    return;
  }

  const commonJobFields = {
    orgId,
    mandateId: mandate.id,
    mandateVersionId: activeVersion.id,
    safeAddress,
    reserveFloorUsd: reserveFloor,
    approvedAssets: activeVersion.approvedAssets as string[],
    approvedProtocols: activeVersion.approvedProtocols as string[],
    approvedActions: activeVersion.approvedActions as string[],
    blockedActions: activeVersion.blockedActions as string[],
    maxSlippageBps: activeVersion.maxSlippageBps as number,
    maxSingleActionUsd: activeVersion.maxSingleActionUsd as number | null,
  };

  if (idleUsd > IDLE_THRESHOLD_USD) {
    const deployAmount = Math.min(
      idleUsd * IDLE_DEPLOY_FRACTION,
      (activeVersion.maxSingleActionUsd as number | null) ?? idleUsd * IDLE_DEPLOY_FRACTION
    );
    const explanation =
      `Detected $${idleUsd.toFixed(2)} idle above reserve floor ($${reserveFloor.toFixed(2)}). ` +
      `Proposing to supply $${deployAmount.toFixed(2)} USDC to Aave V3.`;

    const decisionId = `dec_${randomUUID().slice(0, 12)}`;
    try {
      await createAgentDecision({
        id: decisionId,
        orgId,
        mandateId: mandate.id,
        mandateVersionId: activeVersion.id,
        trigger: "idle_capital_detected",
        observedState: { usdcBalance, aUsdcBalance, idleUsd, reserveFloor },
        selectedPlaybook: "aave_supply_usdc",
        playbookParams: { amountHuman: deployAmount.toFixed(6) },
        rejectedAlternatives: [],
        explanation,
        status: "simulating",
      });
    } catch (err) {
      console.error(`[Agent] Failed to create decision: ${(err as Error).message}`);
      return;
    }

    simQueue.push({
      ...commonJobFields,
      playbook: "aave_supply_usdc",
      amountHuman: deployAmount.toFixed(6),
      onBehalfOf: treasuryAddress,
      trigger: "idle_capital_detected",
      explanation,
      observedLiquidUsd: usdcBalance,
      decisionId,
    });
    drainSimQueue();
  }

  if (reserveBreached) {
    const withdrawAmount = reserveFloor - usdcBalance;
    const explanation =
      `Reserve floor breached: USDC $${usdcBalance.toFixed(2)} < floor $${reserveFloor.toFixed(2)}. ` +
      `Proposing to withdraw $${withdrawAmount.toFixed(2)} USDC from Aave V3.`;

    const decisionId = `dec_${randomUUID().slice(0, 12)}`;
    try {
      await createAgentDecision({
        id: decisionId,
        orgId,
        mandateId: mandate.id,
        mandateVersionId: activeVersion.id,
        trigger: "reserve_floor_breach",
        observedState: { usdcBalance, aUsdcBalance, idleUsd, reserveFloor },
        selectedPlaybook: "aave_withdraw_usdc",
        playbookParams: { amountHuman: withdrawAmount.toFixed(6) },
        rejectedAlternatives: [],
        explanation,
        status: "simulating",
      });
    } catch (err) {
      console.error(`[Agent] Failed to create decision: ${(err as Error).message}`);
      return;
    }

    simQueue.push({
      ...commonJobFields,
      playbook: "aave_withdraw_usdc",
      amountHuman: withdrawAmount.toFixed(6),
      onBehalfOf: treasuryAddress,
      trigger: "reserve_floor_breach",
      explanation,
      observedLiquidUsd: usdcBalance,
      decisionId,
    });
    drainSimQueue();
  }
}

// ─── Scan all orgs ────────────────────────────────────────────

async function scanAllOrgs(): Promise<void> {
  console.log("[Agent] Starting mandate scan...");
  let orgs: Awaited<ReturnType<typeof listOrgs>>;
  try {
    orgs = await listOrgs();
  } catch (err) {
    console.error(`[Agent] Failed to list orgs: ${(err as Error).message}`);
    return;
  }

  const active = orgs.filter(o => o.wallets && o.wallets.length > 0);
  if (active.length === 0) {
    console.log("[Agent] No orgs with wallets, scan complete.");
    return;
  }

  await Promise.allSettled(
    active.map(org => {
      // Prefer wallet registered on active chain; fall back to any wallet.
      // EVM addresses are chain-agnostic — the same address works on all chains.
      const chainWallets = org.wallets.filter(w => w.chainId === activeChainId);
      const walletAddress = chainWallets[0]?.address ?? org.wallets[0]?.address ?? "";
      if (!walletAddress) return Promise.resolve();
      return scanOrg(org.id, org.safeAddress ?? null, walletAddress);
    })
  );

  console.log(`[Agent] Scan complete: ${active.length} orgs checked`);
}

// ─── Reconciliation ───────────────────────────────────────────

async function reconcilePending(): Promise<void> {
  let pending: Awaited<ReturnType<typeof getSubmittedExecutionRecords>>;
  try {
    pending = await getSubmittedExecutionRecords();
  } catch { return; }

  if (pending.length === 0) return;

  console.log(`[Agent] Reconciling ${pending.length} submitted record(s)...`);

  for (const rec of pending) {
    if (!rec.safeTxId) continue;
    try {
      const safeAddress = rec.accountAddress as Address;
      const status = await getSafeExecutionStatus(safeAddress, rec.safeTxId as `0x${string}`);
      if (!status?.isExecuted || !status.executionTxHash) continue;

      const existing = await getPositionByDeployTxHash(status.executionTxHash).catch(() => null);
      if (existing) {
        await markExecutionReconciled(rec.id, status.executionTxHash, new Date(status.executedAt ?? Date.now())).catch(() => {});
        continue;
      }

      const simArtifact = await getSimulationArtifact(rec.simulationArtifactId).catch(() => null);
      let deployedUsd = 0;
      if (simArtifact?.expectedDeltas) {
        const d = simArtifact.expectedDeltas as Record<string, string>;
        const spentKey = Object.keys(d).find(k => k.endsWith("_spent"));
        if (spentKey) {
          const raw = Math.abs(Number(d[spentKey]));
          deployedUsd = raw > 1e12 ? raw / 1e18 : raw / 1e6;
        }
      }

      const positionId = `pos_${randomUUID().slice(0, 12)}`;
      await createPosition({
        id: positionId,
        orgId: rec.orgId,
        graph: {
          id: `graph_${positionId}`,
          name: "Aave V3 USDC Supply",
          description: "USDC supplied to Aave V3 on Base",
          entryAsset: "USDC",
          exitAsset: "USDC",
          nodes: [{ id: "n1", protocol: "aave-v3", action: "supply", inputAsset: "USDC", outputAsset: "USDC", expectedApyBps: 450, gasCostUsd: 0, risks: [], metadata: {} }],
          edges: [],
          estimatedApyBps: 450,
          totalGasCostUsd: 0,
          createdAt: new Date(),
        },
        status: "active",
        chainId: activeChainId,
        entryValueUsd: deployedUsd,
        currentValueUsd: deployedUsd,
        deployTxHash: status.executionTxHash,
        safeAddress,
        mandateVersionId: rec.mandateVersionId,
        simulationArtifactId: rec.simulationArtifactId,
      });

      await markExecutionReconciled(rec.id, status.executionTxHash, new Date(status.executedAt ?? Date.now()));

      if (simArtifact?.decisionId) {
        await updateAgentDecisionStatus(simArtifact.decisionId, "executed").catch(() => {});
      }

      console.log(`[Agent] ✅ Reconciled: pos=${positionId} tx=${status.executionTxHash}`);
    } catch (err) {
      console.error(`[Agent] Reconcile error for ${rec.id}: ${(err as Error).message}`);
    }
  }
}

// ─── Lifecycle ────────────────────────────────────────────────

let scanTimer: ReturnType<typeof setInterval> | null = null;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startAgentLoop(): void {
  if (running) return;
  running = true;

  console.log(
    `[Agent] Starting autonomous loop (scan=${SCAN_INTERVAL_MS / 1000}s, ` +
    `reconcile=${RECONCILE_INTERVAL_MS / 1000}s, ` +
    `chain=${activeChainId}, forkMode=${isForkMode()})`
  );

  // Immediate first run
  void scanAllOrgs().catch(err => console.error("[Agent] Initial scan failed:", err));
  void reconcilePending().catch(err => console.error("[Agent] Initial reconcile failed:", err));

  scanTimer = setInterval(() => {
    void scanAllOrgs().catch(err => console.error("[Agent] Scan error:", err));
  }, SCAN_INTERVAL_MS);

  reconcileTimer = setInterval(() => {
    void reconcilePending().catch(err => console.error("[Agent] Reconcile error:", err));
  }, RECONCILE_INTERVAL_MS);
}

export function stopAgentLoop(): void {
  if (!running) return;
  running = false;
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
  console.log("[Agent] Autonomous loop stopped.");
}

/** Force-scan a single org immediately (bypasses the 5-min interval). */
export async function forceScanOrg(orgId: string): Promise<void> {
  const { listOrgs } = await import("@defi-composer/db");
  const orgs = await listOrgs();
  const org = orgs.find(o => o.id === orgId);
  if (!org) {
    console.warn(`[Agent] forceScanOrg: org ${orgId} not found`);
    return;
  }
  const chainWallets = org.wallets.filter((w: { chainId: number }) => w.chainId === activeChainId);
  const walletAddress = (chainWallets[0] ?? org.wallets[0])?.address ?? "";
  if (!walletAddress) {
    console.warn(`[Agent] forceScanOrg: no wallet for org ${orgId}`);
    return;
  }
  await scanOrg(org.id, org.safeAddress ?? null, walletAddress);
}

export function getAgentStatus() {
  return {
    running,
    scanIntervalMs: SCAN_INTERVAL_MS,
    reconcileIntervalMs: RECONCILE_INTERVAL_MS,
    pendingSimulations: simQueue.length,
    runningSims,
    forkMode: isForkMode(),
    chainId: activeChainId,
  };
}
