// ============================================================
// Planner Service
// BullMQ worker: intent → AI strategies → risk scored → DB stored
//
// Full pipeline:
//   1. Fetch org governance risk params from DB
//   2. Generate candidate strategies via StrategyPlanner (LLM + fallback)
//   3. Apply full deterministic risk scoring via RiskEngine
//   4. Filter by org-level protocol allowlist + hard blockers
//   5. Persist candidates to DB
//   6. Publish to Redis pub/sub (WebSocket handler picks this up)
// ============================================================

import "dotenv/config";
import { Worker, Queue } from "bullmq";
import { Redis } from "ioredis";
import {
  getOrg,
  updateIntentStatus,
  storeCandidates,
} from "@defi-composer/db";
import { StrategyPlanner } from "@defi-composer/strategy-engine";
import { RiskEngine } from "@defi-composer/risk-engine";
import type { UserIntent } from "@defi-composer/shared";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

const connection = {
  host: new URL(REDIS_URL).hostname,
  port: parseInt(new URL(REDIS_URL).port || "6379"),
};

// Separate Redis client for pub/sub (BullMQ uses its own connection)
const pubClient = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

const planner = new StrategyPlanner();
const riskEngine = new RiskEngine();

// ─── Queue definition (used by backend to enqueue jobs) ───────────────────────
export const plannerQueue = new Queue("strategy-planning", { connection });

// ─── Job payload ─────────────────────────────────────────────────────────────
export interface PlanningJobPayload {
  intentId: string;
  intent: UserIntent;
  orgId: string;
  maxCandidates?: number;
}

export interface PlanningJobResult {
  intentId: string;
  candidateCount: number;
  generatedAt: string;
  modelUsed: string;
  generationMs: number;
}

// ─── Worker ───────────────────────────────────────────────────────────────────
export function startPlannerWorker() {
  const worker = new Worker<PlanningJobPayload, PlanningJobResult>(
    "strategy-planning",
    async (job) => {
      const { intentId, intent, orgId, maxCandidates = 3 } = job.data;
      const startedAt = Date.now();

      console.log(`[Planner] intent=${intentId} org=${orgId}`);

      // Mark intent as in-progress so frontend can show spinner
      await updateIntentStatus(intentId, "planning");

      // ── Step 1: Fetch org to apply governance constraints ──────────────────
      const org = await getOrg(orgId);
      if (!org) {
        await updateIntentStatus(intentId, "failed");
        throw new Error(`Organization ${orgId} not found`);
      }

      // Org-level risk params are governance-voted — they override user prefs.
      // A DAO that voted "no leverage" means no leverage even if user says yes.
      const constrainedIntent: UserIntent = {
        ...intent,
        allowLeverage: intent.allowLeverage && org.riskParams.allowLeverage,
        allowLiquidationRisk:
          intent.allowLiquidationRisk && org.riskParams.allowLiquidationRisk,
      };

      // ── Step 2: AI generates candidate strategy graphs ─────────────────────
      await job.updateProgress(20);
      const rawCandidates = await planner.generateCandidates(constrainedIntent);
      const generationInfo = planner.getLastGenerationInfo();
      const modelUsed = `${generationInfo.provider}:${generationInfo.model}`;
      console.log(`[Planner] AI returned ${rawCandidates.length} raw candidates`);

      // ── Step 3: Full deterministic risk scoring (never LLM-based) ──────────
      await job.updateProgress(50);
      const scoredCandidates = await Promise.all(
        rawCandidates.map(async (candidate) => {
          const riskScore = await riskEngine.assess(
            candidate.graph,
            constrainedIntent,
            constrainedIntent.capitalUsd
          );
          return { ...candidate, riskScore };
        })
      );

      // ── Step 4: Apply org protocol allowlist (governance constraint) ────────
      const { approvedProtocols } = org.riskParams;
      const protocolFiltered =
        approvedProtocols.length > 0
          ? scoredCandidates.filter((c) =>
              c.graph.nodes.every((node) =>
                approvedProtocols.includes(node.protocol)
              )
            )
          : scoredCandidates;

      // Drop hard blockers (constraint violations, liquidation risk mismatches)
      const validCandidates = protocolFiltered
        .filter((c) => c.riskScore.blockers.length === 0)
        .slice(0, maxCandidates);

      console.log(
        `[Planner] ${scoredCandidates.length} scored → ` +
          `${protocolFiltered.length} protocol-ok → ` +
          `${validCandidates.length} valid`
      );

      // ── Step 5: Persist to DB ──────────────────────────────────────────────
      await job.updateProgress(80);
      const generationMs = Date.now() - startedAt;

      if (validCandidates.length > 0) {
        await storeCandidates(
          validCandidates.map((c, i) => ({
            id: c.id,
            intentId,
            orgId,
            candidate: c,
            rank: i + 1,
            estimatedApyBps: c.graph.estimatedApyBps,
            riskLevel: c.riskScore.overallLevel,
            recommended: c.recommended ? 1 : 0,
            modelUsed,
            generationMs,
          }))
        );
      }

      // Update intent: ready or failed (if all candidates were blocked)
      await updateIntentStatus(
        intentId,
        validCandidates.length > 0 ? "ready" : "failed",
        { candidateCount: validCandidates.length }
      );

      // ── Step 6: Publish to Redis pub/sub for WebSocket notify ──────────────
      await pubClient.publish(
        `intent:${intentId}:ready`,
        JSON.stringify({
          intentId,
          orgId,
          count: validCandidates.length,
          generatedAt: new Date().toISOString(),
        })
      );

      await job.updateProgress(100);
      console.log(
        `[Planner] Done: ${validCandidates.length} candidates in ${generationMs}ms`
      );

      return {
        intentId,
        candidateCount: validCandidates.length,
        generatedAt: new Date().toISOString(),
        modelUsed,
        generationMs,
      };
    },
    {
      connection,
      concurrency: 3,
        limiter: {
          max: 10,
        duration: 60_000, // 10 jobs/min — conservative buffer across providers
      },
    }
  );

  worker.on("failed", async (job, err) => {
    console.error(`[Planner] Job ${job?.id} failed: ${err.message}`);
    if (job?.data.intentId) {
      await updateIntentStatus(job.data.intentId, "failed").catch(() => {});
    }
  });

  worker.on("completed", (job, result) => {
    console.log(
      `[Planner] Job ${job.id} completed: ${result.candidateCount} candidates`
    );
  });

  return worker;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
if (process.env["NODE_ENV"] !== "test") {
  console.log("[Planner Service] Starting worker...");
  startPlannerWorker();
  console.log("[Planner Service] Worker running. Waiting for jobs...");
}
