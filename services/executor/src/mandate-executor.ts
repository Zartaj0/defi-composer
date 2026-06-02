// ============================================================
// Mandate Simulation Worker
// BullMQ worker: AgentDecision → fork simulation → SimulationArtifact → ExecutionRecord
//
// Pipeline:
//   1. Receive agent decision job (playbook + params + mandate version)
//   2. Fetch active mandate version from DB
//   3. Run MandateSimulator (Base fork, no real keys)
//   4. Persist SimulationArtifact to DB
//   5. If passed  → create ExecutionRecord (status: proposed)
//              → update AgentDecision status to "ready"
//   6. If failed  → update AgentDecision status to "blocked"
//   7. Publish result to Redis for WebSocket notify
//
// In V1, production_proposal mode is blocked — all execution
// goes through Safe proposal UI after fork proves the action.
// ============================================================

import "dotenv/config";
import { Worker, Queue } from "bullmq";
import { Redis } from "ioredis";
// Use Node.js built-in crypto.randomUUID() to avoid global uuid package conflict
import { randomUUID as uuidv4 } from "node:crypto";
import {
  getMandate,
  getOrg,
  createSimulationArtifact,
  createExecutionRecord,
  createAgentDecision,
  createPosition,
  updateAgentDecisionStatus,
} from "@defi-composer/db";
import {
  mandateSimulator,
  type PlaybookName,
  type MandatePolicy,
} from "@defi-composer/simulation-engine";
import {
  submitSafeProposal,
  getSafeInfo,
  executePolicyModule,
  isPolicyModuleEnabled,
} from "@defi-composer/execution-engine";
import { buildSafeTxStruct, getActiveChainId } from "@defi-composer/simulation-engine";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const connection = {
  host: new URL(REDIS_URL).hostname,
  port: parseInt(new URL(REDIS_URL).port || "6379"),
};

const pubClient = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

// ─── Job payload ──────────────────────────────────────────────
export interface MandateSimulationJobPayload {
  orgId: string;
  mandateId: string;
  playbook: PlaybookName;
  amountHuman: string;
  /** Safe or treasury address — used as onBehalfOf/recipient in generated calldata.
   *  Defaults to fork test wallet if omitted (development only). */
  onBehalfOf?: string;
  trigger: string;
  explanation: string;
  observedLiquidUsd: number;
  // Optional: link to a pre-created AgentDecision row
  existingDecisionId?: string;
}

export interface MandateSimulationJobResult {
  decisionId: string;
  simulationId: string;
  executionRecordId: string | null;
  status: "ready" | "blocked" | "failed";
  failureReason: string | null;
  gasEstimate: number;
}

// ─── Fork mode flag ──────────────────────────────────────────
// Matches the check used by MandateSimulator: fork mode is default (on unless explicitly disabled)
function isForkMode(): boolean {
  const v = process.env["FORK_MODE"];
  return v !== "false" && v !== "0";
}

// ─── Queue (importable by API and agent loop) ─────────────────
export const mandateSimulationQueue = new Queue<MandateSimulationJobPayload>(
  "mandate-simulation",
  { connection }
);

// ─── Worker ───────────────────────────────────────────────────
export function startMandateSimulationWorker() {
  const worker = new Worker<MandateSimulationJobPayload, MandateSimulationJobResult>(
    "mandate-simulation",
    async (job) => {
      const {
        orgId,
        mandateId,
        playbook,
        amountHuman,
        onBehalfOf,
        trigger,
        explanation,
        observedLiquidUsd,
        existingDecisionId,
      } = job.data;

      console.log(
        `[MandateExecutor] job=${job.id} org=${orgId} playbook=${playbook} amount=${amountHuman}`
      );
      await job.updateProgress(10);

      // ── Step 1: Fetch active mandate ───────────────────────
      const mandate = await getMandate(mandateId);
      if (!mandate) {
        throw new Error(`Mandate ${mandateId} not found`);
      }
      if (mandate.status !== "active") {
        throw new Error(
          `Mandate ${mandateId} is not active (status: ${mandate.status}). ` +
          "Activate the mandate before running simulations."
        );
      }

      // Find the active version
      const activeVersion = mandate.versions.find(
        (v) => v.id === mandate.activeVersionId
      );
      if (!activeVersion) {
        throw new Error(`No active version found for mandate ${mandateId}`);
      }

      // ── Step 2: Create or reuse AgentDecision ──────────────
      let decisionId = existingDecisionId;
      if (!decisionId) {
        decisionId = `dec_${uuidv4().slice(0, 12)}`;
        await createAgentDecision({
          id: decisionId,
          orgId,
          mandateId,
          mandateVersionId: activeVersion.id,
          trigger,
          observedState: { liquidUsd: observedLiquidUsd },
          selectedPlaybook: playbook,
          playbookParams: { amountHuman },
          rejectedAlternatives: [],
          explanation,
          status: "simulating",
        });
      }

      await job.updateProgress(20);

      // ── Step 3: Build mandate policy for simulator ─────────
      const policy: MandatePolicy = {
        mandateVersionId: activeVersion.id,
        approvedAssets: activeVersion.approvedAssets as string[],
        approvedProtocols: activeVersion.approvedProtocols as string[],
        approvedActions: activeVersion.approvedActions as string[],
        blockedActions: activeVersion.blockedActions as string[],
        maxSlippageBps: activeVersion.maxSlippageBps,
        ...(activeVersion.maxSingleActionUsd != null
          ? { maxSingleActionUsd: activeVersion.maxSingleActionUsd }
          : {}),
        reserveFloorUsd: activeVersion.reserveFloorUsd,
      };

      // ── Step 4: Run fork simulation ────────────────────────
      await job.updateProgress(30);
      let artifact;
      try {
        artifact = await mandateSimulator.run({
          playbook,
          mandate: policy,
          params: {
            amountHuman,
            // Use the Safe/treasury address as onBehalfOf so generated calldata
            // correctly names the beneficiary in supply/withdraw calls.
            ...(onBehalfOf ? { onBehalfOf: onBehalfOf as `0x${string}` } : {}),
          },
          observedState: { liquidUsd: observedLiquidUsd },
          decisionId,
          orgId,
        });
      } catch (err) {
        // Simulation threw (Anvil crash, network, etc.) — mark as failed
        const artifactId = `sim_${uuidv4().slice(0, 12)}`;
        const rpcSource = process.env["BASE_RPC_URL"] ?? "https://mainnet.base.org";
        artifact = {
          id: artifactId,
          orgId,
          decisionId,
          mandateVersionId: activeVersion.id,
          chainId: getActiveChainId(),
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

      // ── Step 5: Persist simulation artifact ───────────────
      await job.updateProgress(60);
      const simulationId = artifact.id;
      await createSimulationArtifact({
        id: simulationId,
        orgId,
        decisionId,
        mandateVersionId: activeVersion.id,
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

      // ── Step 6: Create execution record if simulation passed
      await job.updateProgress(80);
      let executionRecordId: string | null = null;
      let finalStatus: "ready" | "blocked" | "failed" = "failed";

      if (artifact.status === "passed") {
        executionRecordId = `exec_${uuidv4().slice(0, 12)}`;

        const org = await getOrg(orgId);
        const safeAddress = org?.safeAddress ?? null;

        // ── Fork mode: simulation proof + fork position ───────
        if (isForkMode()) {
          // The fork simulation DID execute the transaction on Anvil — it's real proof.
          // Create an execution record as "proposed" (not "reconciled" — no mainnet tx).
          await createExecutionRecord({
            id: executionRecordId,
            orgId,
            simulationArtifactId: simulationId,
            mandateVersionId: activeVersion.id,
            accountAddress: safeAddress ?? `0x${"0".repeat(40)}`,
            status: "proposed",
          });

          // Create a fork-backed position from the simulation proof.
          // deployTxHash uses "sim:" prefix — not a real on-chain tx hash.
          // tags: ["fork_simulation"] — UI can render these differently.
          const deltas = artifact.expectedDeltas as Record<string, string>;
          // Use the input (spent) side — the output (received) reflects the fork's
          // accumulated balance, not the delta this specific tx added.
          const spentKey = Object.keys(deltas).find(k => k.endsWith("_spent"));
          const deployedValueRaw = spentKey ? Math.abs(Number(deltas[spentKey])) : 0;
          // >1e12 → 18-decimal (WETH), else 6-decimal (USDC)
          const deployedValueUsd = deployedValueRaw > 1e12
            ? deployedValueRaw / 1e18
            : deployedValueRaw / 1e6;
          const positionId = `pos_${uuidv4().slice(0, 12)}`;

          await createPosition({
            id: positionId,
            orgId,
            graph: {
              id: `graph_${positionId}`,
              name: `${playbook.replace(/_/g, " ")} (fork)`,
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
                gasCostUsd: artifact.gasEstimate * 3e-9,  // rough gas cost estimate
                risks: [],
                metadata: { forkBlock: artifact.forkBlockNumber },
              }],
              edges: [],
              estimatedApyBps: 450,
              totalGasCostUsd: artifact.gasEstimate * 3e-9,
              createdAt: new Date(),
            },
            status: "active",
            chainId: getActiveChainId(),
            entryValueUsd: deployedValueUsd || parseFloat(amountHuman),
            currentValueUsd: deployedValueUsd || parseFloat(amountHuman),
            deployTxHash: `sim:${simulationId}`,
            safeAddress: safeAddress ?? null,
            mandateVersionId: activeVersion.id,
            simulationArtifactId: simulationId,
            tags: ["fork_simulation"],
            notes: `Fork-proven at block ${artifact.forkBlockNumber}. Calldata hash: ${artifact.calldataHash}. Gas: ${artifact.gasEstimate.toLocaleString()}`,
          });

          // Mark decision as ready (proven by fork)
          if (decisionId) {
            await updateAgentDecisionStatus(decisionId, "ready");
          }

          finalStatus = "ready";
          console.log(
            `[MandateExecutor] ✅ Fork simulation passed + position created: decision=${decisionId} ` +
            `sim=${simulationId} exec=${executionRecordId} pos=${positionId} ` +
            `value=$${(deployedValueUsd || parseFloat(amountHuman)).toFixed(2)} ` +
            `gas=${artifact.gasEstimate.toLocaleString()}`
          );

        } else {
          // ── Production path ────────────────────────────────────
          // Build SafeTx struct once — shared by both execution paths.
          const calldata = artifact.inputCalldata as Array<{ to: string; data: string; value?: string }>;
          const safeTxStruct = buildSafeTxStruct(calldata, artifact.gasEstimate);

          // Derive declared USDC amount from simulation deltas (6-decimal).
          // PolicyEnforcedModule.execute() requires this for its onchain spend accounting.
          const prodDeltas = artifact.expectedDeltas as Record<string, string>;
          const prodSpentKey = Object.keys(prodDeltas).find(k => k.endsWith("_spent"));
          const prodRawAmt = prodSpentKey ? Math.abs(Number(prodDeltas[prodSpentKey])) : 0;
          // >1e12 ⇒ 18-decimal (WETH) → convert to USDC 6-dec; else already 6-dec
          const declaredUsdcAmount = prodRawAmt > 1e12
            ? Math.round((prodRawAmt / 1e18) * 1e6)
            : prodRawAmt > 0 ? prodRawAmt
            : Math.round(parseFloat(amountHuman) * 1e6);

          // ── Route: PolicyEnforcedModule (autonomous) vs Safe proposal ──
          const policyModuleEnabled = await isPolicyModuleEnabled().catch(() => false);
          let usedPolicyModule = false;

          if (policyModuleEnabled && safeAddress && process.env["EXECUTOR_PRIVATE_KEY"]) {
            try {
              console.log(
                `[MandateExecutor] 🤖 PolicyEnforcedModule active — executing autonomously ` +
                `(amount=$${(declaredUsdcAmount / 1e6).toFixed(2)}, safe=${safeAddress})`
              );

              const policyResult = await executePolicyModule({
                safeTxStruct,
                simulationId,
                declaredUsdcAmount,
              });
              usedPolicyModule = true;

              // Tx is already on-chain — record as fully reconciled immediately
              await createExecutionRecord({
                id: executionRecordId,
                orgId,
                simulationArtifactId: simulationId,
                mandateVersionId: activeVersion.id,
                accountAddress: safeAddress,
                status: "reconciled",
                transactionHash: policyResult.txHash,
                submittedAt: new Date(policyResult.executedAt),
                executedAt: new Date(policyResult.executedAt),
                reconciledAt: new Date(),
              });

              if (decisionId) {
                await updateAgentDecisionStatus(decisionId, "executed").catch(() => {});
              }

              finalStatus = "ready";
              console.log(
                `[MandateExecutor] ✅ Autonomous execution complete: decision=${decisionId} ` +
                `sim=${simulationId} exec=${executionRecordId} txHash=${policyResult.txHash} ` +
                `block=${policyResult.blockNumber} gas=${artifact.gasEstimate.toLocaleString()}`
              );

            } catch (err) {
              // PolicyModule execution failed (policy check, limit exceeded, etc.)
              // Non-fatal: fall through to Safe proposal as fallback.
              console.warn(
                `[MandateExecutor] PolicyModule execution failed — falling back to Safe proposal: ` +
                `${err instanceof Error ? err.message : String(err)}`
              );
            }
          } else if (!policyModuleEnabled) {
            console.log(`[MandateExecutor] PolicyModule not enabled — using Safe proposal (human sig required)`);
          } else if (!safeAddress) {
            console.log(`[MandateExecutor] PolicyModule enabled but no Safe address — using Safe proposal`);
          } else {
            console.log(`[MandateExecutor] EXECUTOR_PRIVATE_KEY not set — skipping auto-submit`);
          }

          // ── Fallback: Safe TX Service proposal ──────────────────
          if (!usedPolicyModule) {
            let safeTxId: string | null = null;
            let executionStatus: "proposed" | "submitted" = "proposed";

            if (safeAddress && process.env["EXECUTOR_PRIVATE_KEY"]) {
              try {
                // Validate it's a real Safe before submitting
                const safeInfo = await getSafeInfo(safeAddress as `0x${string}`);
                if (safeInfo) {
                  const submitResult = await submitSafeProposal({
                    safeAddress: safeAddress as `0x${string}`,
                    safeTxStruct,
                    simulationId,
                  });

                  safeTxId = submitResult.safeTxHash;
                  executionStatus = "submitted";
                  console.log(
                    `[MandateExecutor] 🔐 Safe proposal submitted: ${safeTxId} ` +
                    `(nonce=${submitResult.nonce}, safe=${safeAddress})`
                  );
                } else {
                  console.warn(`[MandateExecutor] Safe address ${safeAddress} not found on Base — skipping auto-submit`);
                }
              } catch (err) {
                // Auto-submit failure is non-fatal — execution record still created
                console.warn(
                  `[MandateExecutor] Safe auto-submit failed (manual submit still possible): ` +
                  `${err instanceof Error ? err.message : String(err)}`
                );
              }
            } else if (!safeAddress) {
              console.log(`[MandateExecutor] No Safe address on org — execution record created, manual submission required`);
            }

            await createExecutionRecord({
              id: executionRecordId,
              orgId,
              simulationArtifactId: simulationId,
              mandateVersionId: activeVersion.id,
              accountAddress: safeAddress ?? `0x${"0".repeat(40)}`,
              status: executionStatus,
              ...(safeTxId ? { safeTxId } : {}),
              ...(executionStatus === "submitted" ? { submittedAt: new Date() } : {}),
            });

            if (decisionId) {
              await updateAgentDecisionStatus(decisionId, "ready").catch(() => {});
            }

            finalStatus = "ready";
            console.log(
              `[MandateExecutor] ✅ Done: decision=${decisionId} sim=${simulationId} ` +
              `exec=${executionRecordId} gas=${artifact.gasEstimate.toLocaleString()} ` +
              `status=${executionStatus}`
            );
          }
        }
      } else {
        finalStatus = "blocked";
        // Mark decision as blocked so the mandate monitor can re-scan on next cycle
        if (decisionId) {
          await updateAgentDecisionStatus(decisionId, "blocked").catch(() => {});
        }
        console.log(
          `[MandateExecutor] ❌ Simulation ${artifact.status}: ${artifact.failureReason}`
        );
      }

      // ── Step 7: Publish result to Redis ───────────────────
      await job.updateProgress(90);
      await pubClient.publish(
        "defi-composer:mandate-simulation",
        JSON.stringify({
          orgId,
          mandateId,
          decisionId,
          simulationId,
          executionRecordId,
          status: finalStatus,
          playbook,
          gasEstimate: artifact.gasEstimate,
          failureReason: artifact.failureReason,
          timestamp: new Date().toISOString(),
        })
      );

      await job.updateProgress(100);

      return {
        decisionId,
        simulationId,
        executionRecordId,
        status: finalStatus,
        failureReason: artifact.failureReason,
        gasEstimate: artifact.gasEstimate,
      };
    },
    {
      connection,
      concurrency: 2,  // max 2 concurrent Anvil forks to avoid port exhaustion
    }
  );

  worker.on("failed", async (job, err) => {
    console.error(
      `[MandateExecutor] Job ${job?.id} failed: ${err.message}`
    );
  });

  worker.on("completed", (job, result) => {
    console.log(
      `[MandateExecutor] Job ${job.id} done: ` +
      `status=${result.status} gas=${result.gasEstimate.toLocaleString()}`
    );
  });

  return worker;
}

// NOTE: Worker is started by executor/index.ts — do not auto-start here.
