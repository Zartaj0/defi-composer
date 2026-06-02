// ============================================================
// Strategy Routes
// POST /api/v1/strategy/generate  — synchronous: AI → risk → simulate → rank
// GET  /api/v1/strategy/:id       — fetch a stored candidate strategy
// POST /api/v1/strategy/:id/deploy — queue execution job, create pending position
// ============================================================

import type { FastifyPluginAsync } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { Queue } from "bullmq";
import { StrategyPlanner } from "@defi-composer/strategy-engine";
import { RiskEngine } from "@defi-composer/risk-engine";
import { SimulationEngine } from "@defi-composer/simulation-engine";
import {
  getCandidate,
  getOrg,
  createPosition,
  updateIntentStatus,
} from "@defi-composer/db";
import type {
  UserIntent,
  CandidateStrategy,
  ApiResponse,
} from "@defi-composer/shared";

const planner = new StrategyPlanner();
const riskEngine = new RiskEngine();
const simulator = new SimulationEngine();

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const redisConnection = {
  host: new URL(REDIS_URL).hostname,
  port: parseInt(new URL(REDIS_URL).port || "6379"),
};
const executionQueue = new Queue("strategy-execution", {
  connection: redisConnection,
});

// ─── Routes ───────────────────────────────────────────────────────────────────
export const strategyRoutes: FastifyPluginAsync = async (app) => {

  // ── POST /generate — synchronous full pipeline (used for demo/preview) ─────
  // For production flows use the async BullMQ planner — this endpoint is for
  // immediate/interactive use where the user wants instant feedback.
  app.post<{ Body: { intent: UserIntent } }>(
    "/generate",
    async (request, reply) => {
      const { intent } = request.body;
      const requestId = uuidv4();

      try {
        app.log.info({ intentId: intent.id }, "Synchronous strategy generation");

        // AI generates candidates
        const candidates = await planner.generateCandidates(intent);

        // Deterministic risk scoring + simulation in parallel per candidate
        const scoredCandidates = await Promise.all(
          candidates.map(async (candidate) => {
            const [riskScore, simulation] = await Promise.all([
              riskEngine.assess(candidate.graph, intent, intent.capitalUsd),
              simulator.simulate(
                candidate.graph,
                intent.capitalUsd,
                "0x0000000000000000000000000000000000000000"
              ),
            ]);
            return { ...candidate, riskScore, simulation } satisfies CandidateStrategy;
          })
        );

        // Filter hard blockers
        const valid = scoredCandidates.filter(
          (c) => c.riskScore.blockers.length === 0
        );

        return reply.status(200).send({
          success: true,
          data: valid,
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<CandidateStrategy[]>);
      } catch (err) {
        app.log.error({ err, requestId }, "Strategy generation failed");
        return reply.status(500).send({
          success: false,
          error: err instanceof Error ? err.message : "Strategy generation failed",
          requestId,
          timestamp: new Date(),
        });
      }
    }
  );

  // ── GET /:id — fetch a stored candidate by ID ──────────────────────────────
  app.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const requestId = uuidv4();
    try {
      const row = await getCandidate(request.params.id);
      if (!row) {
        return reply.status(404).send({
          success: false,
          error: "Strategy not found",
          requestId,
          timestamp: new Date(),
        });
      }

      return reply.status(200).send({
        success: true,
        data: row.candidate,
        requestId,
        timestamp: new Date(),
      } satisfies ApiResponse<CandidateStrategy>);
    } catch (err) {
      app.log.error(err);
      return reply.status(500).send({
        success: false,
        error: "Failed to fetch strategy",
        requestId,
        timestamp: new Date(),
      });
    }
  });

  // ── POST /:id/deploy — queue execution, create pending position ────────────
  // This is called when the user selects a strategy and confirms deployment.
  // We do NOT sign anything here — execution requires Safe multisig approval.
  app.post<{
    Params: { id: string };
    Body: {
      intentId: string;
      orgId: string;
      walletAddress: string;
      safeAddress?: string;
      capitalUsd: number;
    };
  }>("/:id/deploy", async (request, reply) => {
    const { intentId, orgId, walletAddress, safeAddress, capitalUsd } = request.body;
    const requestId = uuidv4();

    try {
      // Fetch the stored candidate strategy
      const row = await getCandidate(request.params.id);
      if (!row) {
        return reply.status(404).send({
          success: false,
          error: "Strategy not found",
          requestId,
          timestamp: new Date(),
        });
      }

      const strategy = row.candidate;

      // Hard guard — re-check blockers at deploy time (market may have moved)
      if (strategy.riskScore.blockers.length > 0) {
        return reply.status(400).send({
          success: false,
          error: `Cannot deploy: ${strategy.riskScore.blockers.join("; ")}`,
          requestId,
          timestamp: new Date(),
        });
      }

      // Simulation must have passed (set during planning)
      if (strategy.simulation && !strategy.simulation.success) {
        return reply.status(400).send({
          success: false,
          error: "Cannot deploy: simulation failed. Re-generate strategies.",
          requestId,
          timestamp: new Date(),
        });
      }

      // Validate org exists and retrieve safe address if not provided
      const org = await getOrg(orgId);
      if (!org) {
        return reply.status(404).send({
          success: false,
          error: `Organization ${orgId} not found`,
          requestId,
          timestamp: new Date(),
        });
      }

      const resolvedSafeAddress =
        (safeAddress as `0x${string}` | undefined) ??
        (org.safeAddress as `0x${string}` | undefined);

      // Create position record immediately as "pending" so frontend can track
      const positionId = `pos_${uuidv4().slice(0, 12)}`;
      await createPosition({
        id: positionId,
        orgId,
        intentId,
        graph: strategy.graph,
        status: "pending",
        chainId: 8453,
        riskScore: strategy.riskScore,
        safeAddress: resolvedSafeAddress ?? null,
        tags: [],
      });

      // Update intent to "selected" state
      await updateIntentStatus(intentId, "selected", { positionId });

      // Queue the actual execution work (simulate → build calldata → propose Safe)
      const job = await executionQueue.add(
        "execute-strategy",
        {
          orgId,
          intentId,
          strategy,
          walletAddress: walletAddress as `0x${string}`,
          safeAddress: resolvedSafeAddress,
          simulationRequired: true,
          capitalUsd: capitalUsd ?? strategy.graph.nodes[0]?.metadata?.["capitalUsd"] ?? 100_000,
        },
        {
          attempts: 3,
          backoff: { type: "exponential", delay: 10_000 },
        }
      );

      app.log.info(
        { positionId, jobId: job.id, strategyId: strategy.id },
        "Execution job queued"
      );

      return reply.status(202).send({
        success: true,
        data: {
          positionId,
          jobId: job.id,
          strategyId: strategy.id,
          status: "pending",
          message: resolvedSafeAddress
            ? `Execution queued. Strategy will be proposed to Safe ${resolvedSafeAddress} for multisig approval.`
            : "Execution queued. Awaiting wallet approval.",
          positionUrl: `/api/v1/positions/${positionId}`,
        },
        requestId,
        timestamp: new Date(),
      });
    } catch (err) {
      app.log.error({ err, requestId }, "Deploy failed");
      return reply.status(500).send({
        success: false,
        error: err instanceof Error ? err.message : "Deploy failed",
        requestId,
        timestamp: new Date(),
      });
    }
  });
};
